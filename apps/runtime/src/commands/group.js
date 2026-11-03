export const groupFeatureSettings = new Map();

function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

function clean(value, limit = 64) {
  return String(value || "").replace(/[\\r\n]/g, " ").trim().slice(0, limit);
}

function participants(metadata) {
  return metadata?.participants || [];
}

function senderJid(message) {
  return message?.key?.participant || message?.participant || "";
}

function mentionedTargets(message) {
  const context = message?.message?.extendedTextMessage?.contextInfo
    || message?.message?.imageMessage?.contextInfo
    || message?.message?.videoMessage?.contextInfo
    || {};
  return [...(context.mentionedJid || []), ...(context.participant ? [context.participant] : [])]
    .filter((jid, index, all) => typeof jid === "string" && all.indexOf(jid) === index);
}

function requireGroup(message) {
  const jid = message?.key?.remoteJid;
  if (!isGroupJid(jid)) throw new Error("This command can only be used inside a WhatsApp group.");
  return jid;
}

async function requireAdmin(socket, jid, message) {
  const metadata = await socket.groupMetadata(jid);
  const actor = senderJid(message);
  const botJid = String(socket.user?.id || "").split(":")[0].split("@")[0];
  const actorEntry = participants(metadata).find(item => item.id === actor);
  const botEntry = participants(metadata).find(item => String(item.id || "").split(":")[0].split("@")[0] === botJid);
  if (!actorEntry?.admin) throw new Error("Only group administrators can use this command.");
  if (!botEntry?.admin) throw new Error("Make CASTRO X MD a group administrator first.");
  return metadata;
}

function adminCommand(name, description, action, usage) {
  return {
    name, category: "Group", description,
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const targets = mentionedTargets(message);
      if (!targets.length) throw new Error(usage || "Mention a group member to continue.");
      if (targets.some(target => target === socket.user?.id)) throw new Error("The bot cannot modify its own group role.");
      await socket.groupParticipantsUpdate(jid, targets, action);
      return { text: `✅ Successfully ${action}d ${targets.length} member(s).` };
    }
  };
}

export const groupCommands = [
  {
    name: "groupinfo", aliases: ["ginfo"], category: "Group",
    description: "Show information about this group.",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      const metadata = await socket.groupMetadata(jid);
      const list = participants(metadata);
      return { text: [
        "╭─〔 *GROUP INFORMATION* 〕", "│",
        `│ Name: ${clean(metadata.subject)}`,
        `│ Members: ${list.length}`,
        `│ Admins: ${list.filter(item => item.admin).length}`,
        `│ Created: ${metadata.creation ? new Date(metadata.creation * 1000).toLocaleDateString("en-GB") : "Unknown"}`,
        "╰─ CASTRO X MD"
      ].join("\n") };
    }
  },
  {
    name: "admins", aliases: ["listadmins"], category: "Group",
    description: "List this group's administrators.",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      const metadata = await socket.groupMetadata(jid);
      const admins = participants(metadata).filter(item => item.admin);
      return { text: admins.length
        ? [`👑 *GROUP ADMINS — ${clean(metadata.subject)}*`, ...admins.map((item, i) => `${i + 1}. ${clean(item.notify || item.name || item.id)}`)].join("\n")
        : "No group administrators were returned by WhatsApp.",
        mentions: admins.map(item => item.id) };
    }
  },
  {
    name: "tagall", aliases: ["everyone"], category: "Group",
    description: "Mention all group members (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      const metadata = await requireAdmin(socket, jid, message);
      const members = participants(metadata);
      const note = clean(args.join(" "), 180);
      return { text: `📢 *ATTENTION ALL MEMBERS*\n${note ? note + "\n\n" : ""}${members.map(p => "@" + p.id.split("@")[0].split(":")[0]).join(" ")}`,
        mentions: members.map(p => p.id) };
    }
  },
  {
    name: "hidetag", aliases: ["notifyall"], category: "Group",
    description: "Quietly mention all group members (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      const metadata = await requireAdmin(socket, jid, message);
      const members = participants(metadata);
      return { text: clean(args.join(" "), 1000) || " ", mentions: members.map(p => p.id) };
    }
  },
  adminCommand("kick", "Remove mentioned members (admin only).", "remove"),
  adminCommand("promote", "Promote mentioned members to admin.", "promote"),
  adminCommand("demote", "Remove admin role from mentioned members.", "demote"),
  {
    name: "groupname", aliases: ["setname"], category: "Group",
    description: "Change the group name (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const name = clean(args.join(" "), 100);
      if (!name) throw new Error("Usage: groupname New group name");
      await socket.groupUpdateSubject(jid, name);
      return { text: "✅ Group name updated." };
    }
  },
  {
    name: "groupdesc", aliases: ["setdesc"], category: "Group",
    description: "Change the group description (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const description = clean(args.join(" "), 500);
      if (!description) throw new Error("Usage: groupdesc New group description");
      await socket.groupUpdateDescription(jid, description);
      return { text: "✅ Group description updated." };
    }
  },
  {
    name: "grouplink", aliases: ["invite"], category: "Group",
    description: "Get the group invite link (admin only).",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const code = await socket.groupInviteCode(jid);
      return { text: `🔗 https://chat.whatsapp.com/${code}` };
    }
  },
  {
    name: "revokelink", aliases: ["resetlink"], category: "Group",
    description: "Reset the group invite link (admin only).",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      await socket.groupRevokeInvite(jid);
      return { text: "✅ Group invite link has been reset." };
    }
  },

  {
    name: "lock", aliases: ["closegroup"], category: "Group",
    description: "Allow only group admins to send messages.",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      await socket.groupSettingUpdate(jid, "announcement");
      return { text: "🔒 Group locked. Only administrators can send messages." };
    }
  },
  {
    name: "unlock", aliases: ["opengroup"], category: "Group",
    description: "Allow all group members to send messages.",
    execute: async ({ socket, message }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      await socket.groupSettingUpdate(jid, "not_announcement");
      return { text: "🔓 Group unlocked. All members can send messages." };
    }
  },


  {
    name: "antilink", aliases: ["linkguard"], category: "Moderation",
    description: "Enable or disable automatic link removal in this group (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const choice = String(args[0] || "").toLowerCase();
      if (!["on", "off", "status"].includes(choice)) throw new Error("Usage: antilink on | off | status");
      const settings = groupFeatureSettings.get(jid) || {};
      if (choice === "status") return { text: `🔗 Anti-link is currently ${settings.antiLink ? "ON" : "OFF"} in this group.` };
      settings.antiLink = choice === "on";
      groupFeatureSettings.set(jid, settings);
      return { text: settings.antiLink ? "🛡️ Anti-link enabled. Non-admin link posts will be removed." : "🔓 Anti-link disabled." };
    }
  },


  {
    name: "welcome", category: "Group",
    description: "Toggle automatic welcome messages for new members (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const choice = String(args[0] || "").toLowerCase();
      if (!["on", "off", "status"].includes(choice)) throw new Error("Usage: welcome on | off | status");
      const settings = groupFeatureSettings.get(jid) || {};
      if (choice === "status") return { text: `👋 Welcome messages are ${settings.welcome ? "ON" : "OFF"}.` };
      settings.welcome = choice === "on";
      groupFeatureSettings.set(jid, settings);
      return { text: settings.welcome ? "👋 Welcome messages enabled." : "Welcome messages disabled." };
    }
  },
  {
    name: "goodbye", category: "Group",
    description: "Toggle automatic goodbye messages when members leave (admin only).",
    execute: async ({ socket, message, args }) => {
      const jid = requireGroup(message);
      await requireAdmin(socket, jid, message);
      const choice = String(args[0] || "").toLowerCase();
      if (!["on", "off", "status"].includes(choice)) throw new Error("Usage: goodbye on | off | status");
      const settings = groupFeatureSettings.get(jid) || {};
      if (choice === "status") return { text: `👋 Goodbye messages are ${settings.goodbye ? "ON" : "OFF"}.` };
      settings.goodbye = choice === "on";
      groupFeatureSettings.set(jid, settings);
      return { text: settings.goodbye ? "👋 Goodbye messages enabled." : "Goodbye messages disabled." };
    }
  },

];