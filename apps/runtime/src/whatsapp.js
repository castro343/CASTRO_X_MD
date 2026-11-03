import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import { attachCommandHandlers } from "./commands.js";
import pino from "pino";
import { EncryptedAuthStore } from "./encrypted-auth-store.js";

export class WhatsAppSessionManager {
  constructor({ supabase, encryptionKey, sessionDir, sessionBucket = null, authStoreFactory = options => new EncryptedAuthStore(options), versionFetcher = fetchLatestBaileysVersion, socketFactory = makeWASocket, signalKeyStoreFactory = makeCacheableSignalKeyStore }) {
    this.supabase = supabase;
    this.encryptionKey = encryptionKey;
    this.sessionDir = sessionDir;
    this.sessionBucket = sessionBucket;
    this.authStoreFactory = authStoreFactory;
    this.versionFetcher = versionFetcher;
    this.socketFactory = socketFactory;
    this.signalKeyStoreFactory = signalKeyStoreFactory;
    this.sockets = new Map();
    this.pending = new Set();
    this.cooldowns = new Map();
    this.reconnectTimers = new Map();
    this.retryCounts = new Map();
    this.stopping = false;
    this.lifecycleGeneration = 0;
    this.logger = pino({ level: process.env.LOG_LEVEL || "info" });
    const configuredAttempts = Number(process.env.MAX_RECONNECT_ATTEMPTS || 8);
    this.maxReconnectAttempts = Number.isInteger(configuredAttempts)
      ? Math.min(20, Math.max(1, configuredAttempts))
      : 8;
  }

  directory(botId) {
    return path.join(this.sessionDir, crypto.createHash("sha256").update(String(botId)).digest("hex"));
  }

  authStore(botId) {
    const directory = this.directory(botId);
    if (this.sessionBucket) {
      const objectPath = `sessions/${crypto.createHash("sha256").update(String(botId)).digest("hex")}/auth.enc`;
      return this.authStoreFactory({
        directory, encryptionKey: this.encryptionKey,
        storage: this.supabase.storage.from(this.sessionBucket), objectPath
      });
    }
    return this.authStoreFactory({ directory, encryptionKey: this.encryptionKey });
  }

  runtimeRef(botId) {
    return crypto.createHash("sha256").update(`castro-x-md:${botId}`).digest("hex");
  }

  async persistStatus(bot, status, paired = false, botStatus = status, reconnectEnabled = true) {
    const now = new Date().toISOString();
    const session = {
      bot_instance_id: bot.id,
      owner_id: bot.owner_id,
      runtime_session_ref: this.runtimeRef(bot.id),
      status,
      reconnect_enabled: reconnectEnabled,
      last_seen_at: now,
      ...(paired ? { paired_at: now } : {})
    };
    const { error: sessionError } = await this.supabase.from("bot_sessions")
      .upsert(session, { onConflict: "bot_instance_id" });
    if (sessionError) throw new Error(`Could not persist WhatsApp session state: ${sessionError.message}`);
    const { error: botError } = await this.supabase.from("bot_instances")
      .update({ status: botStatus }).eq("id", bot.id).eq("owner_id", bot.owner_id);
    if (botError) throw new Error(`Could not update bot status: ${botError.message}`);
  }

  async status(botId) {
    const record = this.sockets.get(botId);
    if (record?.connected) return { status: "connected" };
    if (record?.pairingCode) return { status: "pairing", pairingCode: record.pairingCode, pairingExpiresAt: record.pairingExpiresAt };
    const { data, error } = await this.supabase.from("bot_sessions")
      .select("status,last_seen_at,paired_at").eq("bot_instance_id", botId).maybeSingle();
    if (error) throw new Error("Could not read WhatsApp session status");
    const lastSeenAt = data?.last_seen_at || null;
    const pairingExpiresAt = data?.status === "pairing" && lastSeenAt
      ? new Date(new Date(lastSeenAt).getTime() + 25_000).toISOString()
      : null;
    return { status: data?.status || "not_connected", lastSeenAt, pairedAt: data?.paired_at || null, pairingExpiresAt };
  }

  async createSocket(bot, { pairing = false } = {}) {
    if (this.stopping) throw new Error("Runtime is shutting down");
    const generation = this.lifecycleGeneration;
    if (this.sockets.has(bot.id)) throw new Error("A WhatsApp session is already running for this bot");
    const store = this.authStore(bot.id);
    const { state, saveCreds } = await store.load();
    if (this.stopping || generation !== this.lifecycleGeneration) throw new Error("Runtime is shutting down");
    if (!pairing && !state.creds.registered) {
      this.logger.warn({ botId: bot.id }, "Skipping session without registered WhatsApp credentials");
      return null;
    }
    const { version } = await this.versionFetcher();
    if (this.stopping || generation !== this.lifecycleGeneration) throw new Error("Runtime is shutting down");
    const socket = this.socketFactory({
      version,
      auth: { creds: state.creds, keys: this.signalKeyStoreFactory(state.keys, this.logger) },
      logger: this.logger,
      printQRInTerminal: false,
      browser: ["CASTRO X MD", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false
    });
    const record = { socket, connected: false, pairingCode: null, pairingExpiresAt: null, pairingTimer: null, intentionalClose: false, closed: false, closeError: null, bot, creds: state.creds };
    this.sockets.set(bot.id, record);
    attachCommandHandlers({ socket, bot });
    socket.ev.on("creds.update", () => {
      saveCreds().catch(error => {
        this.logger.error({ err: error, botId: bot.id }, "Could not persist encrypted WhatsApp credentials");
      });
    });
    socket.ev.on("connection.update", async update => {
      try {
        if (this.sockets.get(bot.id) !== record) return;
        if (update.connection === "open") {
          record.connected = true;
          record.pairingCode = null;
          record.pairingExpiresAt = null;
          if (record.pairingTimer) clearTimeout(record.pairingTimer);
          record.pairingTimer = null;
          this.retryCounts.delete(bot.id);
          this.clearReconnect(bot.id);
          await this.persistStatus(bot, "connected", true);
          this.logger.info({ botId: bot.id }, "WhatsApp session connected");
        }
        if (update.connection === "close") {
          record.connected = false;
          record.closed = true;
          record.closeError = update.lastDisconnect?.error || new Error("WhatsApp websocket closed");
          if (this.sockets.get(bot.id) === record) this.sockets.delete(bot.id);
          if (record.intentionalClose || this.stopping) return;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            this.clearReconnect(bot.id);
            this.retryCounts.delete(bot.id);
            await this.authStore(bot.id).remove();
            await this.persistStatus(bot, "revoked", false, "disconnected");
            this.logger.warn({ botId: bot.id }, "WhatsApp session logged out; credentials cleared");
          } else {
            await this.persistStatus(bot, "disconnected", false, "disconnected", true);
            if (record.creds.registered) {
              const retryTimer = setTimeout(() => this.scheduleReconnect(bot), 0);
              retryTimer.unref?.();
            }
          }
        }
      } catch (error) {
        this.logger.error({ err: error, botId: bot.id }, "WhatsApp connection event failed");
      }
    });
    return record;
  }

  clearReconnect(botId) {
    const timer = this.reconnectTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(botId);
  }

  scheduleReconnect(bot) {
    if (this.stopping || this.reconnectTimers.has(bot.id) || this.pending.has(bot.id)) return;
    const attempt = (this.retryCounts.get(bot.id) || 0) + 1;
    if (attempt > this.maxReconnectAttempts) {
      this.logger.error({ botId: bot.id, attempts: this.maxReconnectAttempts }, "WhatsApp reconnect limit reached");
      return;
    }
    this.retryCounts.set(bot.id, attempt);
    const base = Math.min(30_000 * (2 ** (attempt - 1)), 15 * 60_000);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(bot.id);
      if (this.stopping || this.sockets.has(bot.id) || this.pending.has(bot.id)) return;
      this.pending.add(bot.id);
      let failed = false;
      try {
        const record = await this.createSocket(bot);
        if (!record) this.retryCounts.delete(bot.id);
      } catch (error) {
        failed = true;
        this.logger.warn({ err: error, botId: bot.id, attempt }, "WhatsApp reconnect attempt failed");
      } finally {
        this.pending.delete(bot.id);
      }
      if (failed) this.scheduleReconnect(bot);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(bot.id, timer);
    this.logger.info({ botId: bot.id, attempt, delayMs: delay }, "Scheduled WhatsApp reconnect");
  }

  async start() {
    if (!this.sessionBucket) await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const { data: sessions, error: sessionError } = await this.supabase.from("bot_sessions")
      .select("bot_instance_id,owner_id,status,reconnect_enabled")
      .in("status", ["connected", "disconnected"]).eq("reconnect_enabled", true);
    if (sessionError) throw new Error(`Could not load persisted WhatsApp sessions: ${sessionError.message}`);
    if (!sessions?.length) return { restored: 0 };
    const ids = sessions.map(row => row.bot_instance_id);
    const { data: bots, error: botError } = await this.supabase.from("bot_instances")
      .select("id,owner_id,bot_name,status,prefix,mode")
      .in("id", ids).in("status", ["connected", "disconnected"]);
    if (botError) throw new Error(`Could not load bots for session restoration: ${botError.message}`);
    let restored = 0;
    for (const bot of bots || []) {
      if (!sessions.some(row => row.bot_instance_id === bot.id && row.owner_id === bot.owner_id)) continue;
      try {
        const record = await this.createSocket(bot);
        if (record) restored++;
      } catch (error) {
        this.logger.error({ err: error, botId: bot.id }, "Could not restore WhatsApp session");
        this.scheduleReconnect(bot);
      }
    }
    return { restored };
  }

  async waitForPairingSocketReady(record, timeoutMs = 15_000) {
    const ws = record.socket?.ws;
    if (!ws) throw new Error("WhatsApp websocket is unavailable; pairing cannot safely continue");
    if (record.closed || ws.readyState === 3) {
      throw new Error("WhatsApp websocket closed before it became ready");
    }
    if (ws.readyState === 1) return;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeListener?.("open", onOpen);
        ws.removeListener?.("error", onError);
        ws.removeListener?.("close", onClose);
        record.socket.ev.removeListener?.("connection.update", onConnectionUpdate);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = error => finish(new Error(`WhatsApp websocket failed to open: ${error?.message || "unknown error"}`));
      const onClose = () => finish(new Error("WhatsApp websocket closed before it became ready"));
      const onConnectionUpdate = update => {
        if (update.connection === "close") {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          finish(new Error(code ? `WhatsApp closed during pairing startup (code ${code})` : "WhatsApp closed during pairing startup"));
        }
      };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for WhatsApp websocket readiness")), timeoutMs);
      timer.unref?.();
      ws.once?.("open", onOpen);
      ws.once?.("error", onError);
      ws.once?.("close", onClose);
      record.socket.ev.on("connection.update", onConnectionUpdate);
      // Re-check after listeners are installed to avoid missing a fast open event.
      if (ws.readyState === 1) finish();
      else if (record.closed || ws.readyState === 3) onClose();
    });
  }

  async requestPairingCode(bot, phone) {
    if (this.stopping) throw new Error("Runtime is shutting down");
    if (this.sockets.has(bot.id) || this.pending.has(bot.id)) {
      throw new Error("A WhatsApp session is already starting or running for this bot");
    }
    const now = Date.now();
    const waitUntil = this.cooldowns.get(bot.id) || 0;
    if (now < waitUntil) throw new Error(`Please wait ${Math.ceil((waitUntil - now) / 1000)} seconds before requesting another code`);
    this.pending.add(bot.id);
    const configuredCooldown = Number(process.env.PAIRING_COOLDOWN_SECONDS || 60);
    const cooldownSeconds = Number.isFinite(configuredCooldown)
      ? Math.min(3600, Math.max(30, Math.floor(configuredCooldown)))
      : 60;
    try {
      if (!this.sessionBucket) await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
      const store = this.authStore(bot.id);
      const { state } = await store.load();
      if (state.creds.registered) throw new Error("This bot already has a paired WhatsApp session. Use reconnect or disconnect instead of requesting another code.");
      const record = await this.createSocket(bot, { pairing: true });
      if (!record) throw new Error("Could not initialize WhatsApp pairing");
      const configuredTimeout = Number(process.env.PAIRING_SOCKET_READY_TIMEOUT_MS || 15000);
      const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.min(30000, Math.max(5000, configuredTimeout))
        : 15000;
      await this.waitForPairingSocketReady(record, timeoutMs);
      if (this.sockets.get(bot.id) !== record || record.closed) {
        throw new Error("WhatsApp connection closed during startup");
      }
      const code = await record.socket.requestPairingCode(phone.replace(/\D/g, ""));
      record.pairingCode = code;
      record.pairingExpiresAt = new Date(Date.now() + 25_000).toISOString();
      this.cooldowns.set(bot.id, Date.now() + cooldownSeconds * 1000);
      await this.persistStatus(bot, "pairing", false, "pairing", true);
      record.pairingTimer = setTimeout(async () => {
        if (this.sockets.get(bot.id) !== record || record.connected) return;
        record.intentionalClose = true;
        this.sockets.delete(bot.id);
        try { record.socket.end(undefined); } catch {}
        try {
          await this.persistStatus(bot, "not_connected", false, "not_connected", false);
        } catch (error) {
          this.logger.error({ err: error, botId: bot.id }, "Could not persist expired pairing state");
        }
      }, 25_000);
      record.pairingTimer.unref?.();
      return { status: "pairing", code, pairingExpiresAt: record.pairingExpiresAt };
    } catch (error) {
      this.cooldowns.delete(bot.id);
      const record = this.sockets.get(bot.id);
      if (record) {
        if (record.pairingTimer) clearTimeout(record.pairingTimer);
        record.intentionalClose = true;
        this.sockets.delete(bot.id);
        try { record.socket.end(error); } catch {}
      }
      throw error;
    } finally {
      this.pending.delete(bot.id);
    }
  }

  async reconnect(bot) {
    if (this.stopping) throw new Error("Runtime is shutting down");
    if (this.sockets.get(bot.id)?.connected) return { ok: true, status: "connected" };
    if (this.sockets.has(bot.id) || this.pending.has(bot.id)) {
      throw new Error("This bot is already connecting");
    }
    this.pending.add(bot.id);
    this.clearReconnect(bot.id);
    try {
      const store = this.authStore(bot.id);
      const { state } = await store.load();
      if (!state.creds.registered) throw new Error("No paired WhatsApp credentials found. Pair this bot first.");
      await this.persistStatus(bot, "disconnected", false, "disconnected", true);
      const record = await this.createSocket(bot);
      if (!record) throw new Error("Could not start the WhatsApp session");
      return { ok: true, status: "connecting" };
    } finally {
      this.pending.delete(bot.id);
    }
  }

  async disconnect(bot) {
    if (this.pending.has(bot.id)) {
      throw new Error("This bot is still starting or pairing. Wait for that operation to finish, then disconnect it.");
    }
    this.clearReconnect(bot.id);
    this.retryCounts.delete(bot.id);
    const record = this.sockets.get(bot.id);
    if (record) {
      if (record.pairingTimer) clearTimeout(record.pairingTimer);
      record.intentionalClose = true;
      this.sockets.delete(bot.id);
      try { record.socket.end(undefined); } catch {}
    }
    await this.persistStatus(bot, "disconnected", false, "disconnected", false);
    return { ok: true, status: "disconnected" };
  }

  async shutdown() {
    this.stopping = true;
    this.lifecycleGeneration++;
    for (const botId of [...this.reconnectTimers.keys()]) this.clearReconnect(botId);

    // Give in-flight pairing/reconnect operations a short window to finish before
    // sockets are closed. New operations are rejected once stopping is set.
    const drainDeadline = Date.now() + 10_000;
    while (this.pending.size > 0 && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (this.pending.size > 0) {
      this.logger.warn({ pendingBotIds: [...this.pending] }, "Shutdown continuing with operations still pending");
    }

    const closing = [];
    for (const [botId, record] of this.sockets) {
      if (record.pairingTimer) clearTimeout(record.pairingTimer);
      record.intentionalClose = true;
      this.sockets.delete(botId);
      try { closing.push(Promise.resolve(record.socket.end(undefined))); } catch {}
    }
    await Promise.allSettled(closing);
  }
}
