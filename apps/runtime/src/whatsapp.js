import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import pino from "pino";

export class WhatsAppSessionManager {
  constructor({ supabase, encryptionKey, sessionDir }) {
    this.supabase = supabase;
    this.key = crypto.createHash("sha256").update(encryptionKey).digest();
    this.sessionDir = sessionDir;
    this.sockets = new Map();
    this.logger = pino({ level: process.env.LOG_LEVEL || "info" });
  }
  directory(botId) {
    return path.join(this.sessionDir, crypto.createHash("sha256").update(String(botId)).digest("hex"));
  }
  async status(botId) {
    const socket = this.sockets.get(botId);
    return { status: socket?.connected ? "connected" : "disconnected", pairing: Boolean(socket?.pairingCode) };
  }
  async requestPairingCode(bot, phone) {
    if (this.sockets.has(bot.id)) throw new Error("A WhatsApp session is already running for this bot");
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    const dir = this.directory(bot.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version, auth: state, logger: this.logger,
      printQRInTerminal: false, browser: ["CASTRO X MD", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: false
    });
    const record = { socket, connected: false, pairingCode: null, saveCreds };
    this.sockets.set(bot.id, record);
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async update => {
      if (update.connection === "open") {
        record.connected = true;
        record.pairingCode = null;
        await this.supabase.from("bot_instances").update({ status: "connected" }).eq("id", bot.id);
      }
      if (update.connection === "close") {
        record.connected = false;
        this.sockets.delete(bot.id);
        await this.supabase.from("bot_instances").update({ status: "disconnected" }).eq("id", bot.id);
        if (update.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
    });
    try {
      const code = await socket.requestPairingCode(phone.replace(/\D/g, ""));
      record.pairingCode = code;
      await this.supabase.from("bot_instances").update({ status: "pairing" }).eq("id", bot.id);
      return { status: "pairing", code };
    } catch (error) {
      this.sockets.delete(bot.id);
      socket.end(error);
      throw error;
    }
  }
  async disconnect(botId) {
    const record = this.sockets.get(botId);
    if (!record) return;
    this.sockets.delete(botId);
    record.socket.end(undefined);
  }
  async shutdown() {
    for (const id of this.sockets.keys()) await this.disconnect(id);
  }
}
