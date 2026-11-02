function extractText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  return [days ? `${days}d` : null, hours ? `${hours}h` : null, minutes ? `${minutes}m` : null, `${secs}s`]
    .filter(Boolean).join(" ");
}

export function attachCommandHandlers({ socket, bot, getUptime = () => process.uptime() }) {
  const prefix = typeof bot.prefix === "string" && bot.prefix.length <= 4 ? bot.prefix : ".";
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages || []) {
      if (!message.message || message.key.fromMe) continue;
      const jid = message.key.remoteJid || "";
      if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
      const text = extractText(message).trim();
      if (!text.startsWith(prefix)) continue;
      const [command] = text.slice(prefix.length).trim().split(/\\s+/);
      const name = (command || "").toLowerCase();
      let reply;
      if (name === "alive" || name === "ping") {
        reply = "🟢 CASTRO X MD is online.\\nYour WhatsApp connection is active.";
      } else if (name === "menu" || name === "help") {
        reply = [
          "╭─〔 *CASTRO X MD* 〕",
          "│",
          `│ Prefix: ${prefix}`,
          "│ .alive — Check bot status",
          "│ .ping — Check response",
          "│ .runtime — View runtime uptime",
          "│ .menu — Show commands",
          "│",
          "╰─ Secure multi-user WhatsApp platform"
        ].join("\\n");
      } else if (name === "runtime") {
        reply = `⚙️ *CASTRO X MD Runtime*\\nUptime: ${formatUptime(getUptime())}\\nStatus: Operational`;
      } else {
        continue;
      }
      try {
        await socket.sendMessage(jid, { text: reply }, { quoted: message });
      } catch (error) {
        // Keep one malformed message from terminating the event listener.
        console.error("Command reply failed:", error?.message || error);
      }
    }
  });
}
