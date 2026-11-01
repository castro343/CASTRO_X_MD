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
const app = express();
const sessions = new WhatsAppSessionManager({
  supabase,
  encryptionKey: process.env.SESSION_ENCRYPTION_KEY,
  sessionDir: process.env.SESSION_DIR || "/var/lib/castro-x-md/sessions"
});
app.disable("x-powered-by");
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    .select("id,owner_id,bot_name,status,prefix,mode")
    .eq("id", req.params.botId).eq("owner_id", req.user.id).maybeSingle();
  if (error) return res.status(503).json({ error: "Could not verify bot ownership" });
  if (!data) return res.status(404).json({ error: "Bot not found" });
  req.bot = data;
  next();
}

const pairLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });
app.get("/health", (_req, res) => res.json({ ok: true, service: "castro-x-md-runtime", whatsapp: "integrated" }));
app.get("/ready", async (_req, res) => {
  const { error } = await supabase.from("bot_instances").select("id").limit(1);
  if (error) return res.status(503).json({ ok: false, database: "unavailable" });
  res.json({ ok: true, database: "available" });
});
app.get("/api/bots/:botId/status", authenticate, ownedBot, async (req, res) => {
  res.json(await sessions.status(req.bot.id));
});
app.post("/api/bots/:botId/pair", authenticate, pairLimiter, ownedBot, async (req, res) => {
  const parsed = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Phone must be in international format, e.g. +2547XXXXXXXX" });
  try {
    res.json(await sessions.requestPairingCode(req.bot, parsed.data.phone));
  } catch (error) {
    res.status(400).json({ error: error.message || "Pairing request failed" });
  }
});
app.post("/api/bots/:botId/disconnect", authenticate, ownedBot, async (req, res) => {
  await sessions.disconnect(req.bot.id);
  res.json({ ok: true, status: "disconnected" });
});

const port = Number(process.env.PORT || 8080);
const server = app.listen(port, () => console.log(`CASTRO X MD runtime listening on ${port}`));
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
