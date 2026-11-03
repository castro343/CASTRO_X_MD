import test from "node:test";
import assert from "node:assert/strict";
import { attachCommandHandlers, parseCommand } from "../src/commands.js";

function harness(prefix = ".") {
  let handler;
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => { if (event === "messages.upsert") handler = callback; } },
    sendMessage: async (...args) => { sent.push(args); }
  };
  attachCommandHandlers({ socket, bot: { prefix }, getUptime: () => 90 });
  return { dispatch: payload => handler(payload), sent };
}

test("parses command names and arguments separated by spaces or newlines", () => {
  assert.deepEqual(parseCommand("!ping   hello world", "!"), {
    name: "ping", args: ["hello", "world"]
  });
  assert.deepEqual(parseCommand(".menu\nextra", "."), {
    name: "menu", args: ["extra"]
  });
  assert.equal(parseCommand("ping", "."), null);
  assert.equal(parseCommand(".", "."), null);
});

test("responds to alive and ping using the configured prefix", async () => {
  const app = harness("!");
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: "!alive" } },
    { key: { remoteJid: "254700000002@s.whatsapp.net" }, message: { extendedTextMessage: { text: "!ping" } } }
  ] });
  assert.equal(app.sent.length, 2);
  assert.match(app.sent[0][1].text, /is online/);
  assert.match(app.sent[1][1].text, /PONG/);
});

test("menu documents the configured prefix and supported commands", async () => {
  const app = harness("#");
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: "#menu" } }
  ] });
  assert.match(app.sent[0][1].text, /Prefix: #/);
  assert.match(app.sent[0][1].text, /#runtime/);
  assert.match(app.sent[0][1].text, /\\n/);
});

test("help is an alias for menu", async () => {
  const app = harness(".");
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".help" } }
  ] });
  assert.match(app.sent[0][1].text, /CASTRO X MD/);
});

test("runtime command reports formatted uptime", async () => {
  const app = harness(".");
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".runtime" } }
  ] });
  assert.match(app.sent[0][1].text, /Uptime: 1m 30s/);
});

test("ignores non-notification, own, status, newsletter and unknown messages", async () => {
  const app = harness(".");
  await app.dispatch({ type: "append", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".ping" } }
  ] });
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net", fromMe: true }, message: { conversation: ".ping" } },
    { key: { remoteJid: "status@broadcast" }, message: { conversation: ".ping" } },
    { key: { remoteJid: "123@newsletter" }, message: { conversation: ".ping" } },
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".unknown" } }
  ] });
  assert.equal(app.sent.length, 0);
});

test("quotes the triggering message when replying", async () => {
  const app = harness(".");
  const message = { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".ping" } };
  await app.dispatch({ type: "notify", messages: [message] });
  assert.equal(app.sent[0][2].quoted, message);
});
