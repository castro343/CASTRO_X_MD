const linkPattern = /(?:https?:\/\/|www\.)\S+|chat\.whatsapp\.com\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|co|me|info|biz|xyz|site|online|dev|gg)\b/i;
const groupSettings = new Map();

function isGroup(jid) { return typeof jid === "string" && jid.endsWith("@g.us"); }
function getSetting(jid) {
  if (!groupSettings.has(jid)) groupSettings.set(jid, { antilink: true, welcome: false, goodbye: false });
  return groupSettings.get(jid);
}
function sender(message) { return message?.key?.participant || ""; }

async function isAdmin(socket, jid, userJid) {
  try {
    const meta = await socket.groupMetadata(jid);
    return (meta.participants || []).some(p => p.id === userJid && p.admin);
  } catch { return false; }
}

export function attachModerationHandlers({ socket, bot }) {
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages || []) {
      const jid = message?.key?.remoteJid;
      if (!isGroup(jid) || message.key?.fromMe || message.key?.participant === socket.user?.id) continue;
      const body = message.message?.conversation
        || message.message?.extendedTextMessage?.text
        || message.message?.imageMessage?.caption
        || message.message?.videoMessage?.caption || "";
      if (!body || !linkPattern.test(body)) continue;
      const settings = getSetting(jid);
      if (!settings.antilink) continue;
      const author = sender(message);
      if (!author || await isAdmin(socket, jid, author)) continue;
      if (!await isAdmin(socket, jid, socket.user?.id)) continue;
      try {
        await socket.sendMessage(jid, { delete: message.key });
        await socket.groupParticipantsUpdate(jid, [author], "remove");
        await socket.sendMessage(jid, { text: "🚫 Group link detected. The message was removed and the sender was removed by the anti-link rule." });
      } catch (error) {
        console.warn("Anti-link moderation failed:", error?.message || error);
      }
    }
  });

  socket.ev.on("group-participants.update", async update => {
    const jid = update?.id;
    if (!isGroup(jid)) return;
    const settings = getSetting(jid);
    const members = update.participants || [];
    if (!members.length) return;
    let groupName = "the group";
    try { groupName = (await socket.groupMetadata(jid)).subject || groupName; } catch {}
    for (const member of members) {
      const number = String(member).split("@")[0].split(":")[0];
      if (update.action === "add" && settings.welcome) {
        await socket.sendMessage(jid, { text: `👋 Welcome @${number} to *${groupName}*! Please read the group description and enjoy your stay.`, mentions: [member] }).catch(() => {});
      } else if (update.action === "remove" && settings.goodbye) {
        await socket.sendMessage(jid, { text: `👋 @${number} has left *${groupName}*.`, mentions: [member] }).catch(() => {});
      }
    }
  });
}

export const moderationCommands = [
  {
    name: "antilink", category: "Moderation",
    description: "Enable or disable group link protection (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = message?.key?.remoteJid;
      if (!isGroup(jid)) throw new Error("This command can only be used inside a WhatsApp group.");
      if (!await isAdmin(socket, jid, sender(message)) || !await isAdmin(socket, jid, socket.user?.id)) {
        throw new Error("Only group administrators can use this command, and the bot must also be an admin.");
      }
      const settings = getSetting(jid);
      const value = String(args[0] || "").toLowerCase();
      if (value === "on" || value === "enable") settings.antilink = true;
      else if (value === "off" || value === "disable") settings.antilink = false;
      else return { text: `Anti-link is currently *${settings.antilink ? "ON" : "OFF"}*. Use .antilink on or .antilink off.` };
      return { text: `✅ Anti-link is now *${settings.antilink ? "ON" : "OFF"}* for this group. (This temporary setting resets if the bot runtime restarts.)` };
    }
  },
  {
    name: "welcome", category: "Moderation",
    description: "Toggle group welcome messages (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = message?.key?.remoteJid;
      if (!isGroup(jid)) throw new Error("This command can only be used inside a WhatsApp group.");
      if (!await isAdmin(socket, jid, sender(message)) || !await isAdmin(socket, jid, socket.user?.id)) throw new Error("Only group administrators can use this command, and the bot must also be an admin.");
      const settings = getSetting(jid);
      settings.welcome = String(args[0] || "").toLowerCase() === "on";
      return { text: `👋 Welcome messages are now *${settings.welcome ? "ON" : "OFF"}*.` };
    }
  },
  {
    name: "goodbye", category: "Moderation",
    description: "Toggle group goodbye messages (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = message?.key?.remoteJid;
      if (!isGroup(jid)) throw new Error("This command can only be used inside a WhatsApp group.");
      if (!await isAdmin(socket, jid, sender(message)) || !await isAdmin(socket, jid, socket.user?.id)) throw new Error("Only group administrators can use this command, and the bot must also be an admin.");
      const settings = getSetting(jid);
      settings.goodbye = String(args[0] || "").toLowerCase() === "on";
      return { text: `👋 Goodbye messages are now *${settings.goodbye ? "ON" : "OFF"}*.` };
    }
  }
];
