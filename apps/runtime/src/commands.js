import { coreCommands } from "./commands/core.js";
import { groupCommands } from "./commands/group.js";
import { moderationCommands } from "./moderation.js";
import { createCommandRegistry } from "./command-registry.js";

const registry = createCommandRegistry([coreCommands, groupCommands, moderationCommands]);

function extractText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || message?.message?.documentMessage?.caption
    || "";
}

export function parseCommand(text, prefix) {
  const input = String(text || "").trim();
  if (!input.startsWith(prefix)) return null;
  const body = input.slice(prefix.length).trim();
  if (!body) return null;
  const [name, ...args] = body.split(/\s+/);
  return { name: name.toLowerCase(), args };
}

export function attachCommandHandlers({ socket, bot, getUptime = () => process.uptime(), commandModules = [] }) {
  const prefix = typeof bot.prefix === "string" && bot.prefix.length > 0 && bot.prefix.length <= 4
    ? bot.prefix
    : ".";
  const commands = commandModules.length
    ? createCommandRegistry([coreCommands, groupCommands, moderationCommands, ...commandModules])
    : registry;

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages || []) {
      if (!message?.message || message.key?.fromMe) continue;
      const jid = message.key?.remoteJid || "";
      if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;

      const parsed = parseCommand(extractText(message), prefix);
      if (!parsed) continue;

      const command = commands.get(parsed.name);
      if (!command) continue;

      try {
        const result = await command.execute({
          prefix,
          args: parsed.args,
          bot,
          getUptime,
          message,
          socket,
          commands: commands.list()
        });
        if (result?.text) {
          await socket.sendMessage(jid, { text: result.text, ...(Array.isArray(result.mentions) ? { mentions: result.mentions } : {}) }, { quoted: message });
        }
      } catch (error) {
        console.error("Command execution failed:", error?.message || error);
        const detail = String(error?.message || "");
        const safe = /^(This command can only be used inside a WhatsApp group\.|Only group administrators can use this command\.|Make CASTRO X MD a group administrator first\.|Mention a group member to continue\.|Usage:)/.test(detail);
        await socket.sendMessage(jid, { text: safe ? `⚠️ ${detail}` : "⚠️ That command could not be completed. Please try again." }, { quoted: message });
      }
    }
  });
}
