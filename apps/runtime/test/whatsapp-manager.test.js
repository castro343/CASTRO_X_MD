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

test("does not create a socket when shutdown invalidates an in-flight startup", async () => {
  let releaseLoad;
  let loadStarted;
  const started = new Promise(resolve => { loadStarted = resolve; });
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  let socketCreations = 0;
  const manager = new WhatsAppSessionManager({
    supabase: {},
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-test",
    authStoreFactory: () => ({
      load: async () => {
        loadStarted();
        await loadGate;
        return { state: { creds: { registered: true }, keys: {} }, saveCreds: async () => {} };
      }
    }),
    versionFetcher: async () => ({ version: [2, 3000, 0] }),
    socketFactory: () => {
      socketCreations++;
      return { ev: { on: () => {} } };
    },
    signalKeyStoreFactory: keys => keys
  });

  const startup = manager.createSocket({ id: "bot-1", owner_id: "user-1" });
  await started;
  await manager.shutdown();
  releaseLoad();

  await assert.rejects(startup, /Runtime is shutting down/);
  assert.equal(socketCreations, 0);
  assert.equal(manager.sockets.size, 0);
});


test("waits for the WhatsApp websocket open event before requesting a pairing code", async () => {
  const { EventEmitter } = await import("node:events");
  const ws = new EventEmitter();
  ws.readyState = 0;
  const ev = new EventEmitter();
  let requested = false;
  const socket = {
    ws,
    ev,
    requestPairingCode: async phone => {
      assert.equal(ws.readyState, 1);
      assert.equal(phone, "254700000000");
      requested = true;
      return "ABCD-EFGH";
    },
    end() {}
  };
  const supabase = {
    from() {
      return {
        upsert: async () => ({ error: null }),
        update() {
          return {
            eq() {
              return { eq: async () => ({ error: null }) };
            }
          };
        }
      };
    }
  };
  const manager = new WhatsAppSessionManager({
    supabase,
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-pairing-test",
    authStoreFactory: () => ({
      load: async () => ({ state: { creds: { registered: false }, keys: {} }, saveCreds: async () => {} }),
      remove: async () => {}
    }),
    versionFetcher: async () => ({ version: [2, 3000, 0] }),
    socketFactory: () => {
      setTimeout(() => {
        ws.readyState = 1;
        ws.emit("open");
      }, 15);
      return socket;
    },
    signalKeyStoreFactory: keys => keys
  });

  const result = await manager.requestPairingCode(
    { id: "bot-pair-ready", owner_id: "user-1" },
    "254700000000"
  );

  assert.equal(result.code, "ABCD-EFGH");
  assert.equal(requested, true);
  assert.equal(manager.sockets.get("bot-pair-ready").pairingCode, "ABCD-EFGH");
  await manager.shutdown();
});

test("fails pairing promptly when WhatsApp closes before websocket readiness", async () => {
  const { EventEmitter } = await import("node:events");
  const ws = new EventEmitter();
  ws.readyState = 0;
  const ev = new EventEmitter();
  const supabase = {
    from() {
      return {
        upsert: async () => ({ error: null }),
        update() {
          return {
            eq() {
              return { eq: async () => ({ error: null }) };
            }
          };
        }
      };
    }
  };
  const manager = new WhatsAppSessionManager({
    supabase,
    encryptionKey: "test-key",
    sessionDir: "/tmp/castro-x-md-pairing-close-test",
    authStoreFactory: () => ({
      load: async () => ({ state: { creds: { registered: false }, keys: {} }, saveCreds: async () => {} }),
      remove: async () => {}
    }),
    versionFetcher: async () => ({ version: [2, 3000, 0] }),
    socketFactory: () => ({ ws, ev, requestPairingCode: async () => "NEVER", end() {} }),
    signalKeyStoreFactory: keys => keys
  });

  const request = manager.requestPairingCode(
    { id: "bot-pair-close", owner_id: "user-1" },
    "254700000000"
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: Object.assign(new Error("closed"), { output: { statusCode: 428 } }) }
  });

  await assert.rejects(request, /closed during pairing startup/);
  assert.equal(manager.sockets.has("bot-pair-close"), false);
  await manager.shutdown();
});
