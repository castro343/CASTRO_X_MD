const linkPattern = /(?:https?:\\/\\/|www\\.)\\S+|chat\\.whatsapp\\.com\\/\\S+|\\b(?:[a-z0-9-]+\\.)+(?:com|net|org|io|app|co|me|info|biz|xyz|site|online|dev|gg)\\b/i;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ITEMS = 500;

function isGroup(jid) { return typeof jid === "string" && jid.endsWith("@g.us"); }
function normalizeJid(value) { return String(value || "").replace(/:\\d+@/, "@"); }
function sender(message) { return normalizeJid(message?.key?.participant || message?.key?.remoteJid || ""); }
function getText(message) {
  const content = message?.message || {};
  return content.conversation || content.extendedTextMessage?.text
    || content.imageMessage?.caption || content.videoMessage?.caption
    || content.documentMessage?.caption || content.buttonsResponseMessage?.selectedDisplayText
    || content.listResponseMessage?.title || "";
}
function feature(bot, name, fallback = false) {
  return bot?.settings?.features?.[name] ?? fallback;
}
function pruneCache(cache) {
  const now = Date.now();
  for (const [key, value] of cache) if (now - value.at > CACHE_TTL_MS) cache.delete(key);
  while (cache.size > MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
}
async function groupAdminState(socket, jid, actor) {
  const meta = await socket.groupMetadata(jid);
  const list = meta.participants || [];
  const admin = value => list.some(p => normalizeJid(p.id) === normalizeJid(value) && p.admin);
  return { actorIsAdmin: admin(actor), botIsAdmin: admin(socket.user?.id) };
}

export function attachModerationHandlers({ socket, bot }) {
  // Keep anti-delete records inside this bot's handler closure. Message IDs can
  // collide across separate WhatsApp accounts, so a process-wide cache leaks data.
  const deletedCache = new Map();
  const mode = () => bot.mode === "private" ? "private" : "public";

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages || []) {
      const key = message?.key;
      const jid = key?.remoteJid || "";
      if (!key?.id || key.fromMe) continue;
      if (jid === "status@broadcast") {
        if (feature(bot, "statusview")) {
          await socket.readMessages([key]).catch(() => {});
        }
        if (feature(bot, "statusreactions")) {
          const reaction = bot.settings?.statusReaction || "❤️";
          await socket.sendMessage(jid, { react: { text: reaction, key } }).catch(() => {});
        }
        continue;
      }

      // Private mode means direct messages only. Enforce this before caching,
      // moderation, auto-replies, or reactions so group traffic has no side effects.
      if (mode() === "private" && isGroup(jid)) continue;

      const text = getText(message);
      if (text) {
        pruneCache(deletedCache);
        deletedCache.set(key.id, { at: Date.now(), jid, key, text, participant: key.participant || null });
      }

      if (isGroup(jid) && text && feature(bot, "antilink", true) && linkPattern.test(text)) {
        try {
          const { actorIsAdmin, botIsAdmin } = await groupAdminState(socket, jid, sender(message));
          if (!actorIsAdmin && botIsAdmin) {
            await socket.sendMessage(jid, { delete: key });
            await socket.sendMessage(jid, { text: "🚫 Links are not allowed in this group. Your message was removed." });
          }
        } catch (error) { console.warn("Anti-link moderation failed:", error?.message || error); }
      }

      if (isGroup(jid) && text && feature(bot, "antibadwords") && !key.fromMe) {
        const words = (bot.settings?.badWords || []).map(word => String(word).trim().toLowerCase()).filter(Boolean);
        const found = words.some(word => text.toLowerCase().includes(word));
        if (found) {
          try {
            await socket.sendMessage(jid, { delete: key });
            if ((bot.settings?.badWordAction || "delete") === "warn") {
              await socket.sendMessage(jid, { text: "⚠️ Please keep the conversation respectful. Your message was removed." });
            }
          } catch (error) { console.warn("Bad-word moderation failed:", error?.message || error); }
          continue;
        }
      }

      if (text && feature(bot, "autoreply")) {
        const replies = Array.isArray(bot.settings?.autoReplies) ? bot.settings.autoReplies : [];
        const match = replies.find(item => item?.enabled !== false && item?.keyword
          && text.toLowerCase().includes(String(item.keyword).toLowerCase()));
        if (match?.response) {
          const presence = feature(bot, "recording") ? "recording" : feature(bot, "typing") ? "composing" : null;
          if (presence) await socket.sendPresenceUpdate(presence, jid).catch(() => {});
          await socket.sendMessage(jid, { text: String(match.response).slice(0, 1000) }, { quoted: message }).catch(() => {});
          await socket.sendPresenceUpdate("paused", jid).catch(() => {});
        }
      }

      if (text && feature(bot, "customreactions")) {
        const reactions = bot.settings?.reactions || {};
        const entry = Object.entries(reactions).find(([keyword, emoji]) =>
          keyword && emoji && text.toLowerCase().includes(keyword.toLowerCase()));
        if (entry) await socket.sendMessage(jid, { react: { text: String(entry[1]).slice(0, 8), key } }).catch(() => {});
      }
    }
  });

  socket.ev.on("messages.update", async updates => {
    for (const update of updates || []) {
      const protocol = update?.update?.message?.protocolMessage;
      if (protocol?.type !== 0 && protocol?.type !== "REVOKE") continue;
      if (!feature(bot, "antidelete")) continue;
      const original = deletedCache.get(update.key?.id);
      if (!original || Date.now() - original.at > CACHE_TTL_MS) continue;
      deletedCache.delete(update.key.id);
      const label = original.participant ? "A group message" : "A message";
      await socket.sendMessage(original.jid, { text: `🛡️ Anti-delete: ${label} was deleted.\\n\\n${original.text.slice(0, 3000)}` }).catch(() => {});
    }
  });

  socket.ev.on("group-participants.update", async update => {
    const jid = update?.id;
    if (!isGroup(jid)) return;
    const members = update.participants || [];
    if (!members.length) return;
    let groupName = "the group";
    try { groupName = (await socket.groupMetadata(jid)).subject || groupName; } catch {}
    for (const member of members) {
      const number = String(member).split("@")[0].split(":")[0];
      if (update.action === "add" && feature(bot, "welcome")) {
        await socket.sendMessage(jid, { text: `👋 Welcome @${number} to *${groupName}*! Please read the group description and enjoy your stay.`, mentions: [member] }).catch(() => {});
      } else if ((update.action === "remove" || update.action === "leave") && feature(bot, "goodbye")) {
        await socket.sendMessage(jid, { text: `👋 @${number} has left *${groupName}*.`, mentions: [member] }).catch(() => {});
      }
    }
  });
}

async function requireGroupAdmin(socket, message) {
  const jid = message?.key?.remoteJid;
  if (!isGroup(jid)) throw new Error("This command can only be used inside a WhatsApp group.");
  const { actorIsAdmin, botIsAdmin } = await groupAdminState(socket, jid, sender(message));
  if (!actorIsAdmin || !botIsAdmin) throw new Error("Only group administrators can use this command, and the bot must also be an admin.");
}

function toggleCommand(name, label) {
  return {
    name, category: "Moderation", description: `Enable or disable ${label} for this group.`,
    execute: async ({ socket, message, args, bot }) => {
      await requireGroupAdmin(socket, message);
      const value = String(args[0] || "").toLowerCase();
      if (!["on", "off"].includes(value)) return { text: `Use .${name} on or .${name} off.` };
      const settings = bot.settings || (bot.settings = {});
      settings.features ||= {};
      settings.features[name] = value === "on";
      return { text: `✅ ${label} is now *${value.toUpperCase()}* for this group session. Use dashboard settings for saved configuration.` };
    }
  };
}

export const moderationCommands = [
  toggleCommand("antilink", "Anti-link"),
  toggleCommand("welcome", "Welcome messages"),
  toggleCommand("goodbye", "Goodbye messages"),
  toggleCommand("antidelete", "Anti-delete")
];
