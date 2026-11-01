import test from "node:test";
import assert from "node:assert/strict";
import { WhatsAppSessionManager } from "../src/whatsapp.js";

test("rejects new pairing work after shutdown begins", async () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  manager.stopping = true;

  await assert.rejects(
    manager.requestPairingCode({ id: "bot-1", owner_id: "user-1" }, "+254700000000"),
    /Runtime is shutting down/
  );
  assert.equal(manager.pending.size, 0);
  assert.equal(manager.sockets.size, 0);
});

test("rejects reconnect work after shutdown begins", async () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  manager.stopping = true;

  await assert.rejects(
    manager.reconnect({ id: "bot-1", owner_id: "user-1" }),
    /Runtime is shutting down/
  );
  assert.equal(manager.pending.size, 0);
});
