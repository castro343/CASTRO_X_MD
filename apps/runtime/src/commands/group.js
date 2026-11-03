function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

function participantLabel(participant) {
  return String(participant?.notify || participant?.name || participant?.id || "Unknown")
    .replace(/[\\r\\n]/g, " ")
    .slice(0, 64);
}

export const groupCommands = [
  {
    name: "groupinfo",
    aliases: ["ginfo"],
    category: "Group",
    description: "Show information about this group.",
    execute: async ({ socket, message }) => {
      const jid = message?.key?.remoteJid;
      if (!isGroupJid(jid)) return { text: "This command can only be used inside a WhatsApp group." };
      const metadata = await socket.groupMetadata(jid);
      const admins = (metadata.participants || []).filter(item => item.admin);
      return {
        text: [
          "╭─〔 *GROUP INFORMATION* 〕",
          "│",
          `│ Name: ${participantLabel({ notify: metadata.subject })}`,
          `│ Members: ${(metadata.participants || []).length}`,
          `│ Admins: ${admins.length}`,
          `│ Created: ${metadata.creation ? new Date(metadata.creation * 1000).toLocaleDateString("en-GB") : "Unknown"}`,
          "╰─ CASTRO X MD"
        ].join("\\n")
      };
    }
  },
  {
    name: "admins",
    aliases: ["listadmins"],
    category: "Group",
    description: "List this group's administrators.",
    execute: async ({ socket, message }) => {
      const jid = message?.key?.remoteJid;
      if (!isGroupJid(jid)) return { text: "This command can only be used inside a WhatsApp group." };
      const metadata = await socket.groupMetadata(jid);
      const admins = (metadata.participants || []).filter(item => item.admin);
      if (!admins.length) return { text: "No group administrators were returned by WhatsApp." };
      return {
        text: [
          `👑 *GROUP ADMINS — ${participantLabel({ notify: metadata.subject })}*`,
          ...admins.map((item, index) => `${index + 1}. ${participantLabel(item)}`)
        ].join("\\n")
      };
    }
  }
];
