export const coreCommands = [
  {
    name: "alive",
    category: "Core",
    description: "Check whether CASTRO X MD is online.",
    execute: () => ({ text: "🟢 CASTRO X MD is online.\nYour WhatsApp connection is active." })
  },
  {
    name: "ping",
    category: "Core",
    description: "Check bot response.",
    execute: () => ({ text: "🏓 PONG!\nCASTRO X MD is responding." })
  },
  {
    name: "runtime",
    category: "Core",
    description: "View runtime uptime.",
    execute: ({ getUptime }) => ({
      text: `⚙️ *CASTRO X MD Runtime*\nUptime: ${formatUptime(getUptime())}\nStatus: Operational`
    })
  },
  {
    name: "about",
    category: "Core",
    description: "Learn about CASTRO X MD.",
    execute: () => ({
      text: [
        "╭─〔 *ABOUT CASTRO X MD* 〕",
        "│",
        "│ A multi-user WhatsApp bot platform.",
        "│ Built for automation, group tools and",
        "│ useful WhatsApp utilities.",
        "│",
        "╰─ Independent project by CASTRO X MD"
      ].join("\n")
    })
  },
  {
    name: "botinfo",
    aliases: ["bot"],
    category: "Core",
    description: "View this bot's configuration.",
    execute: ({ bot, prefix }) => ({
      text: [
        "╭─〔 *BOT INFORMATION* 〕",
        "│",
        `│ Name: ${safeLabel(bot.bot_name, "CASTRO X MD")}`,
        `│ Prefix: ${prefix}`,
        `│ Mode: ${safeLabel(bot.mode, "public")}`,
        "│ Status: WhatsApp command received",
        "╰─ CASTRO X MD"
      ].join("\n")
    })
  },
  {
    name: "date",
    category: "Utilities",
    description: "Show the current date (UTC).",
    execute: () => ({ text: `📅 Current date (UTC): ${new Date().toISOString().slice(0, 10)}` })
  },
  {
    name: "time",
    category: "Utilities",
    description: "Show the current time (UTC).",
    execute: () => ({ text: `🕒 Current time (UTC): ${new Date().toISOString().slice(11, 19)}` })
  },
  {
    name: "jid",
    aliases: ["chatid"],
    category: "Utilities",
    description: "Show the current chat and sender IDs.",
    execute: ({ message }) => ({
      text: `🆔 Chat ID: ${message?.key?.remoteJid || "Unknown"}\\nSender ID: ${message?.key?.participant || message?.key?.remoteJid || "Unknown"}`
    })
  },
  {
    name: "menu",
    aliases: ["help"],
    category: "Core",
    description: "Show available commands.",
    execute: ({ prefix, commands }) => ({
      text: [
        "╭─〔 *CASTRO X MD* 〕",
        "│",
        `│ Prefix: ${prefix}`,
        ...commands.map(command => `│ ${prefix}${command.name} — ${command.description}`),
        "│",
        "╰─ Secure multi-user WhatsApp platform"
      ].join("\n")
    })
  }
];

function safeLabel(value, fallback) {
  const text = String(value || "").trim().replace(/[\\r\n]/g, " ").slice(0, 48);
  return text || fallback;
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  return [
    days ? `${days}d` : null,
    hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null,
    `${secs}s`
  ].filter(Boolean).join(" ");
}
