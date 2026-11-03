import test from "node:test";
import assert from "node:assert/strict";
import { attachCommandHandlers, parseCommand } from "../src/commands.js";
import { createCommandRegistry } from "../src/command-registry.js";

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
  assert.match(app.sent[0][1].text, /\n/);
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


test("loads additional command modules and resolves aliases", async () => {
  let handler;
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => { if (event === "messages.upsert") handler = callback; } },
    sendMessage: async (...args) => { sent.push(args); }
  };
  attachCommandHandlers({
    socket,
    bot: { prefix: "." },
    commandModules: [[{
      name: "echo",
      aliases: ["say"],
      category: "Utilities",
      description: "Repeat text.",
      execute: ({ args }) => ({ text: args.join(" ") })
    }]]
  });
  await handler({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".say hello from module" } }
  ] });
  assert.equal(sent[0][1].text, "hello from module");
});

test("rejects duplicate command names and aliases", () => {
  assert.throws(() => createCommandRegistry([[
    { name: "echo", execute: () => ({ text: "one" }) },
    { name: "echo", execute: () => ({ text: "two" }) }
  ]]), /Duplicate command name/);
  assert.throws(() => createCommandRegistry([[
    { name: "echo", aliases: ["repeat"], execute: () => ({ text: "one" }) },
    { name: "repeat", execute: () => ({ text: "two" }) }
  ]]), /Duplicate command name|Duplicate command alias/);
});

test("about describes the CASTRO X MD platform", async () => {
  const app = harness(".");
  await app.dispatch({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".about" } }
  ] });
  assert.match(app.sent[0][1].text, /multi-user WhatsApp bot platform/);
});

test("botinfo reports the selected bot configuration safely", async () => {
  let handler;
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => { if (event === "messages.upsert") handler = callback; } },
    sendMessage: async (...args) => { sent.push(args); }
  };
  attachCommandHandlers({
    socket,
    bot: { prefix: "!", bot_name: "CASTRO TEST", mode: "public" }
  });
  await handler({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: "!botinfo" } }
  ] });
  assert.match(sent[0][1].text, /CASTRO TEST/);
  assert.match(sent[0][1].text, /Prefix: !/);
  assert.match(sent[0][1].text, /Mode: public/);
});

test("groupinfo returns group metadata and rejects private chats", async () => {
  let handler;
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => { if (event === "messages.upsert") handler = callback; } },
    groupMetadata: async () => ({
      subject: "Build Team",
      creation: 1700000000,
      participants: [{ id: "1@s.whatsapp.net" }, { id: "2@s.whatsapp.net", admin: "admin" }]
    }),
    sendMessage: async (...args) => { sent.push(args); }
  };
  attachCommandHandlers({ socket, bot: { prefix: "." } });
  await handler({ type: "notify", messages: [
    { key: { remoteJid: "254700000001@s.whatsapp.net" }, message: { conversation: ".groupinfo" } },
    { key: { remoteJid: "12345-678@g.us" }, message: { conversation: ".ginfo" } }
  ] });
  assert.match(sent[0][1].text, /only be used inside a WhatsApp group/);
  assert.match(sent[1][1].text, /Build Team/);
  assert.match(sent[1][1].text, /Members: 2/);
  assert.match(sent[1][1].text, /Admins: 1/);
});

test("admins lists only group administrators", async () => {
  let handler;
  const sent = [];
  const socket = {
    ev: { on: (event, callback) => { if (event === "messages.upsert") handler = callback; } },
    groupMetadata: async () => ({
      subject: "Build Team",
      participants: [
        { id: "111@s.whatsapp.net", notify: "Alice", admin: "admin" },
        { id: "222@s.whatsapp.net", notify: "Bob" }
      ]
    }),
    sendMessage: async (...args) => { sent.push(args); }
  };
  attachCommandHandlers({ socket, bot: { prefix: "." } });
  await handler({ type: "notify", messages: [
    { key: { remoteJid: "12345-678@g.us" }, message: { conversation: ".admins" } }
  ] });
  assert.match(sent[0][1].text, /Alice/);
  assert.doesNotMatch(sent[0][1].text, /Bob/);
});

