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

test("disconnect refuses to race an in-flight operation", async () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  manager.pending.add("bot-1");

  await assert.rejects(
    manager.disconnect({ id: "bot-1", owner_id: "user-1" }),
    /still starting or pairing/
  );
  assert.equal(manager.pending.has("bot-1"), true);
});

test("shutdown closes active sockets and clears reconnect timers", async () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  let ended = 0;
  manager.sockets.set("bot-1", {
    intentionalClose: false,
    socket: { end: () => { ended++; } }
  });
  const timer = setTimeout(() => {}, 60_000);
  manager.reconnectTimers.set("bot-1", timer);

  await manager.shutdown();

  assert.equal(ended, 1);
  assert.equal(manager.sockets.size, 0);
  assert.equal(manager.reconnectTimers.size, 0);
  assert.equal(manager.stopping, true);
});
