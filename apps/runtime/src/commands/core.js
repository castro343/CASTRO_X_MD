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
