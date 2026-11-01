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
    this.cooldowns = new Map();
    this.logger = pino({ level: process.env.LOG_LEVEL || "info" });
  }
  directory(botId) {
    return path.join(this.sessionDir, crypto.createHash("sha256").update(String(botId)).digest("hex"));
  }
  async status(botId) {
    const record = this.sockets.get(botId);
    return { status: record?.connected ? "connected" : record?.pairingCode ? "pairing" : "disconnected" };
  }
  async requestPairingCode(bot, phone) {
    if (this.sockets.has(bot.id)) throw new Error("A WhatsApp session is already running for this bot");
    const now = Date.now();
    const waitUntil = this.cooldowns.get(bot.id) || 0;
    if (now < waitUntil) throw new Error(`Please wait ${Math.ceil((waitUntil-now)/1000)} seconds before requesting another code`);
    this.cooldowns.set(bot.id, now + Number(process.env.PAIRING_COOLDOWN_SECONDS || 60) * 1000);

    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const store = new EncryptedAuthStore({ directory: this.directory(bot.id), encryptionKey: this.encryptionKey });
    const { state, saveCreds } = await store.load();
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version, auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) },
      logger: this.logger, printQRInTerminal: false,
      browser: ["CASTRO X MD", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: false, markOnlineOnConnect: false
    });
    const record = { socket, connected: false, pairingCode: null, intentionalClose: false };
    this.sockets.set(bot.id, record);
    attachCommandHandlers({ socket, bot });
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async update => {
      if (update.connection === "open") {
        record.connected = true;
        record.pairingCode = null;
        await this.supabase.from("bot_instances").update({ status: "connected" }).eq("id", bot.id);
      }
      if (update.connection === "close") {
        record.connected = false;
        if (this.sockets.get(bot.id) === record) this.sockets.delete(bot.id);
        await this.supabase.from("bot_instances").update({ status: "disconnected" }).eq("id", bot.id);
        if (update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          await fs.rm(this.directory(bot.id), { recursive: true, force: true });
        }
      }
    });
    try {
      const code = await socket.requestPairingCode(phone.replace(/\\D/g, ""));
      record.pairingCode = code;
      await this.supabase.from("bot_instances").update({ status: "pairing" }).eq("id", bot.id);
      return { status: "pairing", code };
    } catch (error) {
      this.sockets.delete(bot.id);
      record.intentionalClose = true;
      socket.end(error);
      throw error;
    }
  }
  async disconnect(botId) {
    const record = this.sockets.get(botId);
    if (!record) return;
    this.sockets.delete(botId);
    record.intentionalClose = true;
    record.socket.end(undefined);
    await this.supabase.from("bot_instances").update({ status: "disconnected" }).eq("id", botId);
  }
  async shutdown() {
    for (const id of [...this.sockets.keys()]) await this.disconnect(id);
  }
}
