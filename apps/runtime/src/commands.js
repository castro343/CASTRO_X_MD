import { coreCommands } from "./commands/core.js";
import { groupCommands, groupFeatureSettings } from "./commands/group.js";
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

  socket.ev.on("group-participants.update", async update => {
    const jid = update?.id || "";
    if (!jid.endsWith("@g.us")) return;
    const settings = groupFeatureSettings.get(jid) || {};
    const action = update.action;
    const ids = (update.participants || []).filter(id => typeof id === "string");
    if (!ids.length) return;
    if (action === "add" && settings.welcome) {
      await socket.sendMessage(jid, {
        text: `👋 Welcome ${ids.map(id => "@" + id.split("@")[0].split(":")[0]).join(", ")}! Please read the group description and enjoy your stay.\n\n— CASTRO X MD`,
        mentions: ids
      }).catch(error => console.warn("Welcome message failed:", error?.message || error));
    }
    if ((action === "remove" || action === "leave") && settings.goodbye) {
      await socket.sendMessage(jid, {
        text: `👋 ${ids.map(id => "@" + id.split("@")[0].split(":")[0]).join(", ")} has left the group. Take care!\n\n— CASTRO X MD`,
        mentions: ids
      }).catch(error => console.warn("Goodbye message failed:", error?.message || error));
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages || []) {
      const jid = message?.key?.remoteJid || "";
      if (!jid.endsWith("@g.us") || message.key?.fromMe || jid === "status@broadcast") continue;
      if (!groupFeatureSettings.get(jid)?.antiLink) continue;
      const text = extractText(message);
      if (!/(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|bit\.ly\/)/i.test(text)) continue;
      try {
        const metadata = await socket.groupMetadata(jid);
        const sender = message.key?.participant || "";
        const botId = String(socket.user?.id || "").split(":")[0].split("@")[0];
        const senderIsAdmin = metadata.participants?.some(p => p.id === sender && p.admin);
        const botIsAdmin = metadata.participants?.some(p => String(p.id || "").split(":")[0].split("@")[0] === botId && p.admin);
        if (senderIsAdmin || !botIsAdmin) continue;
        await socket.sendMessage(jid, { delete: message.key });
        await socket.sendMessage(jid, { text: "🚫 Links are not allowed in this group. Your message was removed." });
      } catch (error) {
        console.warn("Anti-link moderation failed:", error?.message || error);
      }
    }
  });

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
