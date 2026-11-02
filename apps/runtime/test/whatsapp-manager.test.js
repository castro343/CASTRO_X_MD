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

test("bounds reconnect attempts from environment configuration", () => {
  const previous = process.env.MAX_RECONNECT_ATTEMPTS;
  try {
    process.env.MAX_RECONNECT_ATTEMPTS = "999";
    const manager = new WhatsAppSessionManager({
      supabase: {},
      encryptionKey: "test-key",
      sessionDir: "/tmp/castro-x-md-test"
    });
    assert.equal(manager.maxReconnectAttempts, 20);
  } finally {
    if (previous === undefined) delete process.env.MAX_RECONNECT_ATTEMPTS;
    else process.env.MAX_RECONNECT_ATTEMPTS = previous;
  }
});

test("does not schedule reconnect after shutdown starts", () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  manager.stopping = true;
  manager.scheduleReconnect({ id: "bot-1" });
  assert.equal(manager.reconnectTimers.size, 0);
  assert.equal(manager.retryCounts.size, 0);
});

test("does not schedule duplicate reconnect timers for one bot", () => {
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test"
  });
  manager.scheduleReconnect({ id: "bot-1" });
  const timer = manager.reconnectTimers.get("bot-1");
  manager.scheduleReconnect({ id: "bot-1" });
  assert.equal(manager.reconnectTimers.size, 1);
  assert.equal(manager.reconnectTimers.get("bot-1"), timer);
  manager.clearReconnect("bot-1");
});
