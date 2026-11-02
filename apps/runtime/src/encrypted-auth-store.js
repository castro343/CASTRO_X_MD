import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const algorithm = "aes-256-gcm";

export class EncryptedAuthStore {
  constructor({ directory, encryptionKey, storage = null, objectPath = null }) {
    this.directory = directory;
    this.storage = storage;
    this.objectPath = objectPath;
    if (Boolean(storage) !== Boolean(objectPath)) throw new Error("Remote auth storage requires both storage and objectPath");
    this.key = crypto.createHash("sha256").update(encryptionKey).digest();
    this.file = directory ? path.join(directory, "auth.enc") : null;
    this.writeChain = Promise.resolve();
    this.data = null;
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(algorithm, this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value, BufferJSON.replacer));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from("CXM1"), iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload) {
    if (payload.subarray(0, 4).toString() !== "CXM1") throw new Error("Unsupported auth file format");
    const iv = payload.subarray(4, 16);
    const tag = payload.subarray(16, 32);
    const ciphertext = payload.subarray(32);
    const decipher = crypto.createDecipheriv(algorithm, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"), BufferJSON.reviver);
  }

  async load() {
    try {
      let payload;
      if (this.storage) {
        const { data, error } = await this.storage.download(this.objectPath);
        if (error) {
          const missing = String(error.statusCode || error.status || "") === "404"
            || /not found/i.test(error.message || "");
          if (!missing) throw error;
          payload = null;
        } else {
          payload = Buffer.from(await data.arrayBuffer());
        }
      } else {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        try { payload = await fs.readFile(this.file); }
        catch (error) { if (error.code !== "ENOENT") throw error; payload = null; }
      }
      this.data = payload ? this.decrypt(payload) : { creds: initAuthCreds(), keys: {} };
      if (!payload) await this.persist();
    } catch (error) {
      throw new Error("Unable to load WhatsApp session safely; refusing to overwrite it");
    }
    const creds = this.data.creds;
    const keys = {
      get: async (type, ids) => {
        const bucket = this.data.keys[type] || {};
        const result = {};
        for (const id of ids) {
          let value = bucket[id];
          if (value && type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value);
          result[id] = value;
        }
        return result;
      },
      set: async (entries) => {
        for (const [type, values] of Object.entries(entries)) {
          this.data.keys[type] ||= {};
          for (const [id, value] of Object.entries(values)) {
            if (value == null) delete this.data.keys[type][id];
            else this.data.keys[type][id] = value;
          }
        }
        await this.persist();
      }
    };
    return {
      state: { creds, keys },
      saveCreds: async () => this.persist()
    };
  }

  persist() {
    // A failed write must not permanently poison the queue for future credential updates.
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const encrypted = this.encrypt(this.data);
      if (this.storage) {
        const { error } = await this.storage.upload(this.objectPath, encrypted, {
          contentType: "application/octet-stream", cacheControl: "0", upsert: true
        });
        if (error) throw new Error("Could not persist encrypted WhatsApp session to remote storage");
      } else {
        const temp = this.file + "." + crypto.randomUUID() + ".tmp";
        try {
          await fs.writeFile(temp, encrypted, { mode: 0o600, flag: "wx" });
          await fs.rename(temp, this.file);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => {});
        }
      }
    });
    return this.writeChain;
  }

  async remove() {
    if (this.storage) {
      const { error } = await this.storage.remove([this.objectPath]);
      if (error) throw new Error("Could not remove encrypted WhatsApp session");
      return;
    }
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}
