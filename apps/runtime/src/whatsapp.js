import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys";
import { attachCommandHandlers } from "./commands.js";
import pino from "pino";
import { EncryptedAuthStore } from "./encrypted-auth-store.js";

export class WhatsAppSessionManager {
  constructor({ supabase, encryptionKey, sessionDir }) {
    this.supabase = supabase;
    this.encryptionKey = encryptionKey;
    this.sessionDir = sessionDir;
    this.sockets = new Map();
    this.pending = new Set();
    this.cooldowns = new Map();
    this.logger = pino({ level: process.env.LOG_LEVEL || "info" });
  }

  directory(botId) {
    return path.join(this.sessionDir, crypto.createHash("sha256").update(String(botId)).digest("hex"));
  }

  runtimeRef(botId) {
    return crypto.createHash("sha256").update(`castro-x-md:${botId}`).digest("hex");
  }

  async persistStatus(bot, status, paired = false) {
    const now = new Date().toISOString();
    const session = {
      bot_instance_id: bot.id,
      owner_id: bot.owner_id,
      runtime_session_ref: this.runtimeRef(bot.id),
      status,
      last_seen_at: now,
      ...(paired ? { paired_at: now } : {})
    };
    const { error: sessionError } = await this.supabase.from("bot_sessions")
      .upsert(session, { onConflict: "bot_instance_id" });
    if (sessionError) throw new Error(`Could not persist WhatsApp session state: ${sessionError.message}`);
    const { error: botError } = await this.supabase.from("bot_instances")
      .update({ status }).eq("id", bot.id).eq("owner_id", bot.owner_id);
    if (botError) throw new Error(`Could not update bot status: ${botError.message}`);
  }

  async status(botId) {
    const record = this.sockets.get(botId);
    if (record?.connected) return { status: "connected" };
    if (record?.pairingCode) return { status: "pairing" };
    const { data, error } = await this.supabase.from("bot_sessions")
      .select("status,last_seen_at,paired_at").eq("bot_instance_id", botId).maybeSingle();
    if (error) throw new Error("Could not read WhatsApp session status");
    return { status: data?.status || "not_connected", lastSeenAt: data?.last_seen_at || null, pairedAt: data?.paired_at || null };
  }

  async requestPairingCode(bot, phone) {
    if (this.sockets.has(bot.id) || this.pending.has(bot.id)) {
      throw new Error("A WhatsApp session is already starting or running for this bot");
    }
    const now = Date.now();
    const waitUntil = this.cooldowns.get(bot.id) || 0;
    if (now < waitUntil) throw new Error(`Please wait ${Math.ceil((waitUntil - now) / 1000)} seconds before requesting another code`);

    this.pending.add(bot.id);
    this.cooldowns.set(bot.id, now + Number(process.env.PAIRING_COOLDOWN_SECONDS || 60) * 1000);
    let socket;
    try {
      await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
      const store = new EncryptedAuthStore({ directory: this.directory(bot.id), encryptionKey: this.encryptionKey });
      const { state, saveCreds } = await store.load();
      if (state.creds.registered) {
        throw new Error("This bot already has a paired WhatsApp session. Reconnect support must be enabled before requesting a new code.");
      }
      const { version } = await fetchLatestBaileysVersion();
      socket = makeWASocket({
        version,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
        logger: this.logger,
        printQRInTerminal: false,
        browser: ["CASTRO X MD", "Chrome", "1.0.0"],
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false
      });
      const record = { socket, connected: false, pairingCode: null, intentionalClose: false };
      this.sockets.set(bot.id, record);
      attachCommandHandlers({ socket, bot });
      socket.ev.on("creds.update", saveCreds);
      socket.ev.on("connection.update", async update => {
        try {
          if (update.connection === "open") {
            record.connected = true;
            record.pairingCode = null;
            await this.persistStatus(bot, "connected", true);
          }
          if (update.connection === "close") {
            record.connected = false;
            if (this.sockets.get(bot.id) === record) this.sockets.delete(bot.id);
            const code = update.lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
              await fs.rm(this.directory(bot.id), { recursive: true, force: true });
              await this.persistStatus(bot, "revoked");
            } else {
              await this.persistStatus(bot, "disconnected");
            }
          }
        } catch (error) {
          this.logger.error({ err: error, botId: bot.id }, "Failed to persist WhatsApp connection state");
        }
      });

      const code = await socket.requestPairingCode(phone.replace(/\D/g, ""));
      record.pairingCode = code;
      await this.persistStatus(bot, "pairing");
      return { status: "pairing", code };
    } catch (error) {
      const record = this.sockets.get(bot.id);
      if (record?.socket === socket) this.sockets.delete(bot.id);
      if (socket) socket.end(error);
      throw error;
    } finally {
      this.pending.delete(bot.id);
    }
  }

  async disconnect(bot) {
    const record = this.sockets.get(bot.id);
    if (record) {
      this.sockets.delete(bot.id);
      record.intentionalClose = true;
      record.socket.end(undefined);
    }
    await this.persistStatus(bot, "disconnected");
    return { ok: true, status: "disconnected" };
  }

  async shutdown() {
    for (const [botId, record] of this.sockets) {
      this.sockets.delete(botId);
      record.intentionalClose = true;
      try { record.socket.end(undefined); } catch {}
    }
  }
}
