import test from "node:test";
import assert from "node:assert/strict";
import { attachModerationHandlers } from "../src/moderation.js";

function harness(bot) {
  const handlers = new Map();
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => handlers.set(event, callback) },
    sendMessage: async (...args) => { sent.push(args); },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({ subject: "Test group", participants: [] }),
    user: { id: "999@s.whatsapp.net" }
  };
  attachModerationHandlers({ socket, bot });
  return { socket, sent, emit: (event, payload) => handlers.get(event)?.(payload) };
}

test("private mode ignores group messages before auto-replies and reactions", async () => {
  const app = harness({
    mode: "private",
    settings: {
      features: { autoreply: true, customreactions: true, antilink: true },
      autoReplies: [{ keyword: "hello", response: "Hi there" }],
      reactions: { hello: "👋" }
    }
  });
  await app.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "private-group-message", remoteJid: "123@g.us", participant: "1@s.whatsapp.net" },
      message: { conversation: "hello https://example.com" }
    }]
  });
  assert.equal(app.sent.length, 0);
});

test("private mode still handles direct-message auto-replies", async () => {
  const app = harness({
    mode: "private",
    settings: { features: { autoreply: true }, autoReplies: [{ keyword: "hello", response: "Hi there" }] }
  });
  const message = {
    key: { id: "direct-message", remoteJid: "254700000001@s.whatsapp.net" },
    message: { conversation: "hello" }
  };
  await app.emit("messages.upsert", { type: "notify", messages: [message] });
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0][1].text, "Hi there");
  assert.equal(app.sent[0][2].quoted, message);
});

test("anti-delete cache is isolated between bot sessions with colliding message IDs", async () => {
  const first = harness({ settings: { features: { antidelete: true } } });
  const second = harness({ settings: { features: { antidelete: true } } });
  await first.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "same-message-id", remoteJid: "254700000001@s.whatsapp.net" },
      message: { conversation: "private message from first account" }
    }]
  });
  await second.emit("messages.update", [{
    key: { id: "same-message-id", remoteJid: "254700000001@s.whatsapp.net" },
    update: { message: { protocolMessage: { type: 0 } } }
  }]);
  assert.equal(second.sent.length, 0);
});

test("anti-delete restores a cached message only within its own session", async () => {
  const app = harness({ settings: { features: { antidelete: true } } });
  await app.emit("messages.upsert", {
    type: "notify",
    messages: [{
      key: { id: "own-message-id", remoteJid: "254700000001@s.whatsapp.net" },
      message: { conversation: "message to restore" }
    }]
  });
  await app.emit("messages.update", [{
    key: { id: "own-message-id" },
    update: { message: { protocolMessage: { type: 0 } } }
  }]);
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0][1].text, /message to restore/);
});
