import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const algorithm = "aes-256-gcm";

export class EncryptedAuthStore {
  constructor({ directory, encryptionKey }) {
    this.directory = directory;
    this.key = crypto.createHash("sha256").update(encryptionKey).digest();
    this.file = path.join(directory, "auth.enc");
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
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.data = this.decrypt(await fs.readFile(this.file));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Unable to decrypt WhatsApp session; refusing to overwrite it");
      this.data = { creds: initAuthCreds(), keys: {} };
      await this.persist();
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
    this.writeChain = this.writeChain.then(async () => {
      const temp = this.file + "." + crypto.randomUUID() + ".tmp";
      await fs.writeFile(temp, this.encrypt(this.data), { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.writeChain;
  }
}
