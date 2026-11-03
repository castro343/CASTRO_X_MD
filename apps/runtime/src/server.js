import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { WhatsAppSessionManager } from "./whatsapp.js";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SESSION_ENCRYPTION_KEY"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
if (Buffer.byteLength(process.env.SESSION_ENCRYPTION_KEY, "utf8") < 32) throw new Error("SESSION_ENCRYPTION_KEY must contain at least 32 bytes");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const sessionBucket = process.env.SUPABASE_SESSION_BUCKET || "castro-x-md-sessions";

async function ensurePrivateSessionBucket() {
  const { data, error } = await supabase.storage.getBucket(sessionBucket);
  if (!error && data) {
    if (data.public) throw new Error("WhatsApp session bucket must be private");
    return;
  }
  if (error && String(error.statusCode || error.status || "") !== "404"
      && !/not found/i.test(error.message || "")) {
    throw new Error("Could not verify private WhatsApp session bucket");
  }
  const { error: createError } = await supabase.storage.createBucket(sessionBucket, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ["application/octet-stream"]
  });
  if (createError && !/already exists/i.test(createError.message || "")) {
    throw new Error("Could not create private WhatsApp session bucket");
  }
}

const app = express();
const sessions = new WhatsAppSessionManager({
  supabase,
  encryptionKey: process.env.SESSION_ENCRYPTION_KEY,
  sessionDir: process.env.SESSION_DIR || "/var/lib/castro-x-md/sessions",
  sessionBucket
});
app.disable("x-powered-by");
// Render sits behind a trusted reverse proxy; needed for correct client IP rate limiting.
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));

const allowedOrigins = new Set((process.env.DASHBOARD_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    // Settings are saved with PUT, so browsers must be allowed to preflight that method.
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Authentication required" });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid or expired access token" });
    req.user = data.user;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed" });
  }
}

async function ownedBot(req, res, next) {
  const { data, error } = await supabase.from("bot_instances")
    .select("id,owner_id,bot_name,status,prefix,mode,settings")
    .eq("id", req.params.botId).eq("owner_id", req.user.id).maybeSingle();
  if (error) return res.status(503).json({ error: "Could not verify bot ownership" });
  if (!data) return res.status(404).json({ error: "Bot not found" });
  req.bot = data;
  next();
}

const pairLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });
app.get("/health", (_req, res) => res.json({ ok: true, service: "castro-x-md-runtime", whatsapp: "integrated" }));
app.get("/api/bots/:botId/status", authenticate, ownedBot, async (req, res) => {
  res.json(await sessions.status(req.bot.id));
});
app.post("/api/bots/:botId/pair", authenticate, pairLimiter, ownedBot, async (req, res) => {
  const parsed = z.object({ phone: z.string().min(8).max(24) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid WhatsApp phone number." });
  let digits = parsed.data.phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    return res.status(400).json({ error: "Enter an international WhatsApp number with country code, e.g. 254758102401 or 447700900123." });
  }
  try {
    res.json(await sessions.requestPairingCode(req.bot, digits));
  } catch (error) {
    const detail = String(error?.message || "");
    console.warn("WhatsApp pairing request failed:", detail || "Unknown error");
    const userMessage = /already.*paired|already.*running|wait \d+ seconds/i.test(detail)
      ? detail
      : /connection closed|websocket closed|closed during pairing startup|timed out waiting for whatsapp websocket/i.test(detail)
        ? "WhatsApp did not keep the pairing connection open long enough. Wait 30 seconds, then request a new code. If it keeps happening, try again later."
        : "Pairing could not start. Check the bot session and try again.";
    res.status(400).json({ error: userMessage });
  }
});
const featureNames = ["antilink","antidelete","antiviewonce","antibadwords","autoreply","customreactions","statusview","statusreactions","typing","recording","welcome","goodbye"];
function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const features = {};
  for (const name of featureNames) if (typeof source.features?.[name] === "boolean") features[name] = source.features[name];
  const badWords = Array.isArray(source.badWords) ? source.badWords.slice(0, 50).map(x => String(x).trim().slice(0, 40)).filter(Boolean) : [];
  const autoReplies = Array.isArray(source.autoReplies) ? source.autoReplies.slice(0, 30).map(item => ({
    keyword: String(item?.keyword || "").trim().slice(0, 60),
    response: String(item?.response || "").trim().slice(0, 500),
    enabled: item?.enabled !== false
  })).filter(item => item.keyword && item.response) : [];
  const reactions = {};
  if (source.reactions && typeof source.reactions === "object" && !Array.isArray(source.reactions)) {
    for (const [key, value] of Object.entries(source.reactions).slice(0, 30)) {
      const keyword = String(key).trim().slice(0, 40), emoji = String(value || "").trim().slice(0, 8);
      if (keyword && emoji) reactions[keyword] = emoji;
    }
  }
  return { ...(source.features ? {} : {}), features, badWords, autoReplies, reactions,
    badWordAction: source.badWordAction === "warn" ? "warn" : "delete",
    statusReaction: String(source.statusReaction || "❤️").slice(0, 8) };
}
app.get("/api/bots/:botId/settings", authenticate, ownedBot, (req, res) => {
  res.json({ settings: req.bot.settings || {} });
});
app.put("/api/bots/:botId/settings", authenticate, ownedBot, async (req, res) => {
  const parsed = z.object({ settings: z.record(z.string(), z.unknown()), mode: z.enum(["private", "public"]).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid feature settings." });
  const settings = sanitizeSettings(parsed.data.settings);
  const { error } = await supabase.from("bot_instances").update({ settings, ...(parsed.data.mode ? { mode: parsed.data.mode } : {}) })
    .eq("id", req.bot.id).eq("owner_id", req.user.id);
  if (error) return res.status(503).json({ error: "Could not save feature settings." });
  const active = sessions.sockets.get(req.bot.id);
  if (active) { active.bot.settings = settings; if (parsed.data.mode) active.bot.mode = parsed.data.mode; }
  res.json({ ok: true, settings });
});

app.post("/api/bots/:botId/reconnect", authenticate, ownedBot, async (req, res) => {
  try {
    res.json(await sessions.reconnect(req.bot));
  } catch (error) {
    console.warn("WhatsApp reconnect request failed:", error);
    res.status(400).json({ error: "Reconnect request failed. Check the session state and try again." });
  }
});
app.post("/api/bots/:botId/disconnect", authenticate, ownedBot, async (req, res) => {
  try {
    const result = await sessions.disconnect(req.bot);
    res.json(result);
  } catch (error) {
    console.warn("WhatsApp disconnect request failed:", error);
    res.status(409).json({ error: "Disconnect could not be completed. Wait for any active operation to finish, then try again." });
  }
});

let runtimeReady = false;
app.get("/ready", async (_req, res) => {
  if (!runtimeReady) return res.status(503).json({ ok: false, runtime: "starting" });
  const { error } = await supabase.from("bot_instances").select("id").limit(1);
  if (error) return res.status(503).json({ ok: false, database: "unavailable" });
  res.json({ ok: true, database: "available", sessions: "restoration_started" });
});

const port = Number(process.env.PORT || 8080);
const server = app.listen(port, async () => {
  try {
    await ensurePrivateSessionBucket();
    const result = await sessions.start();
    runtimeReady = true;
    console.log(`CASTRO X MD runtime listening on ${port}; restored ${result.restored} session(s)`);
  } catch (error) {
    console.error("Runtime session restoration failed:", error);
    process.exitCode = 1;
    server.close(() => process.exit(1));
  }
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await sessions.shutdown();
  await new Promise(resolve => server.close(resolve));
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
