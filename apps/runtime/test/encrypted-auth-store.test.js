import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EncryptedAuthStore } from "../src/encrypted-auth-store.js";

async function temporaryStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cxm-auth-"));
  return {
    directory,
    store: new EncryptedAuthStore({ directory, encryptionKey: "test-encryption-key-that-is-long-enough" }),
    cleanup: () => fs.rm(directory, { recursive: true, force: true })
  };
}

test("creates and reloads an encrypted auth store", async () => {
  const fixture = await temporaryStore();
  try {
    const first = await fixture.store.load();
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.state.keys.set({ "session": { "key-1": { value: "secret" } } });

    const second = new EncryptedAuthStore({
      directory: fixture.directory,
      encryptionKey: "test-encryption-key-that-is-long-enough"
    });
    const restored = await second.load();
    assert.equal(restored.state.creds.registered, true);
    assert.deepEqual(await restored.state.keys.get("session", ["key-1"]), {
      "key-1": { value: "secret" }
    });
    const file = await fs.readFile(path.join(fixture.directory, "auth.enc"));
    assert.equal(file.subarray(0, 4).toString(), "CXM1");
    assert.equal(file.includes(Buffer.from("secret")), false);
  } finally {
    await fixture.cleanup();
  }
});

test("refuses to overwrite an auth file encrypted with another key", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.load();
    const wrongKeyStore = new EncryptedAuthStore({
      directory: fixture.directory,
      encryptionKey: "a-different-encryption-key-value"
    });
    await assert.rejects(wrongKeyStore.load(), /Unable to decrypt WhatsApp session/);
  } finally {
    await fixture.cleanup();
  }
});

test("writes auth files with owner-only permissions", async () => {
  const fixture = await temporaryStore();
  try {
    await fixture.store.load();
    const info = await fs.stat(path.join(fixture.directory, "auth.enc"));
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    await fixture.cleanup();
  }
});


test("persists encrypted auth data to isolated remote storage and restores it", async () => {
  let remote = null;
  const storage = {
    list: async () => ({ data: remote ? [{ name: "auth.enc" }] : [], error: null }),
    download: async () => ({ data: remote ? new Blob([remote]) : null, error: null }),
    upload: async (_path, payload) => { remote = Buffer.from(payload); return { error: null }; },
    remove: async () => { remote = null; return { error: null }; }
  };
  const options = {
    directory: null,
    encryptionKey: "remote-test-encryption-key-that-is-long",
    storage,
    objectPath: "sessions/account-hash/auth.enc"
  };
  const first = new EncryptedAuthStore(options);
  const loaded = await first.load();
  loaded.state.creds.registered = true;
  await loaded.saveCreds();
  assert.ok(remote);
  assert.equal(remote.subarray(0, 4).toString(), "CXM1");
  assert.equal(remote.includes(Buffer.from("registered")), false);

  const second = new EncryptedAuthStore(options);
  const restored = await second.load();
  assert.equal(restored.state.creds.registered, true);
  await second.remove();
  assert.equal(remote, null);
});

test("does not replace a remote auth object when storage download fails", async () => {
  let uploads = 0;
  const storage = {
    list: async () => ({ data: [{ name: "auth.enc" }], error: null }),
    download: async () => ({ data: null, error: new Error("temporary storage outage") }),
    upload: async () => { uploads++; return { error: null }; },
    remove: async () => ({ error: null })
  };
  const store = new EncryptedAuthStore({
    directory: null,
    encryptionKey: "remote-test-encryption-key-that-is-long",
    storage,
    objectPath: "sessions/account-hash/auth.enc"
  });
  await assert.rejects(store.load(), /Unable to decrypt WhatsApp session/);
  assert.equal(uploads, 0);
});
