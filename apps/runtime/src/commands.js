function extractText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || message?.message?.documentMessage?.caption
    || "";
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

const COMMANDS = new Map([
  ["alive", ({ prefix }) => ({
    text: "🟢 CASTRO X MD is online.\\nYour WhatsApp connection is active."
  })],
  ["ping", ({ prefix }) => ({
    text: "🏓 PONG!\\nCASTRO X MD is responding."
  })],
  ["runtime", ({ getUptime }) => ({
    text: `⚙️ *CASTRO X MD Runtime*\\nUptime: ${formatUptime(getUptime())}\\nStatus: Operational`
  })],
  ["menu", ({ prefix }) => ({
    text: [
      "╭─〔 *CASTRO X MD* 〕",
      "│",
      `│ Prefix: ${prefix}`,
      `│ ${prefix}alive — Check bot status`,
      `│ ${prefix}ping — Check response`,
      `│ ${prefix}runtime — View runtime uptime`,
      `│ ${prefix}menu — Show commands`,
      "│",
      "╰─ Secure multi-user WhatsApp platform"
    ].join("\\n")
  })],
  ["help", ({ prefix }) => COMMANDS.get("menu")({ prefix })]
]);

export function parseCommand(text, prefix) {
  const input = String(text || "").trim();
  if (!input.startsWith(prefix)) return null;
  const body = input.slice(prefix.length).trim();
  if (!body) return null;
  const [name, ...args] = body.split(/\\s+/);
  return { name: name.toLowerCase(), args };
}

export function attachCommandHandlers({ socket, bot, getUptime = () => process.uptime() }) {
  const prefix = typeof bot.prefix === "string" && bot.prefix.length > 0 && bot.prefix.length <= 4
    ? bot.prefix
    : ".";

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages || []) {
      if (!message?.message || message.key?.fromMe) continue;
      const jid = message.key?.remoteJid || "";
      if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;

      const parsed = parseCommand(extractText(message), prefix);
      if (!parsed) continue;

      const handler = COMMANDS.get(parsed.name);
      if (!handler) continue;

      try {
        const result = handler({ prefix, args: parsed.args, bot, getUptime, message });
        await socket.sendMessage(jid, { text: result.text }, { quoted: message });
      } catch (error) {
        console.error("Command execution failed:", error?.message || error);
      }
    }
  });
}
