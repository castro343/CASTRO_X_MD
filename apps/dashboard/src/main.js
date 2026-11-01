import { createClient } from "@supabase/supabase-js";
import { getBotRuntimeStatus, requestBotPairingCode, reconnectBot, disconnectBot } from "./runtime-client.js";
import "./style.css";

const config = window.CASTRO_X_MD_CONFIG || {};
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || config.supabaseUrl || "";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || config.supabaseAnonKey || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const $ = id => document.getElementById(id);
let session = null;
let bots = [];
let signupMode = false;

function message(id, text = "") { $(id).textContent = text; }
function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function token() { return session?.access_token; }

function showAuth() { $("auth-view").hidden = false; $("dashboard-view").hidden = true; }
function showDashboard() { $("auth-view").hidden = true; $("dashboard-view").hidden = false; $("user-email").textContent = session?.user?.email || ""; }

async function loadBots() {
  const { data, error } = await supabase.from("bot_instances").select("id,bot_name,prefix,mode,status,created_at").order("created_at", { ascending:false });
  if (error) throw error;
  bots = data || [];
  $("total-count").textContent = bots.length;
  $("connected-count").textContent = bots.filter(bot => bot.status === "connected").length;
  $("bot-list").innerHTML = bots.length ? bots.map(bot => `
    <article class="bot-card" data-bot="${escapeHtml(bot.id)}">
      <div class="bot-head"><h3>${escapeHtml(bot.bot_name)}</h3><span class="badge ${bot.status === "connected" ? "connected" : ""}" data-status>${escapeHtml(bot.status.replaceAll("_"," "))}</span></div>
      <p class="bot-meta">Prefix <b>${escapeHtml(bot.prefix)}</b> · ${escapeHtml(bot.mode)} · Created ${new Date(bot.created_at).toLocaleDateString()}</p>
      <div class="bot-actions">
        <button class="outline" data-action="status">Refresh status</button>
        <button class="primary" data-action="pair">Pair WhatsApp</button>
        <button class="outline" data-action="reconnect">Reconnect</button>
        <button class="outline" data-action="disconnect">Disconnect</button>
      </div>
      <div class="pair-box" data-pair-box hidden></div>
    </article>`).join("") : '<div class="panel bot-card"><h3>No bots yet</h3><p class="muted">Create your first bot instance to get started.</p></div>';
}

async function refreshOne(card) {
  const botId = card.dataset.bot;
  const result = await getBotRuntimeStatus(botId, token());
  const status = result.status || "unknown";
  card.querySelector("[data-status]").textContent = status.replaceAll("_"," ");
  card.querySelector("[data-status]").className = "badge" + (status === "connected" ? " connected" : "");
  const bot = bots.find(item => item.id === botId);
  if (bot) bot.status = status;
  $("connected-count").textContent = bots.filter(item => item.status === "connected").length;
  return result;
}

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase) return message("auth-message", "Dashboard configuration is missing. Set Supabase URL and publishable/anon key.");
  const button = $("auth-submit"); button.disabled = true; message("auth-message", "Please wait…");
  try {
    const email = $("email").value.trim(), password = $("password").value;
    const result = signupMode ? await supabase.auth.signUp({ email, password }) : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (signupMode && !result.data.session) {
      message("auth-message", "Account created. Check your email to confirm, then sign in.");
      return;
    }
    session = result.data.session;
    await ensureProfile();
    showDashboard(); await loadBots();
  } catch (error) { message("auth-message", error.message || "Authentication failed."); }
  finally { button.disabled = false; }
});

async function ensureProfile() {
  if (!session?.user) return;
  const { error } = await supabase.from("profiles").upsert({ id:session.user.id, email:session.user.email }, { onConflict:"id" });
  if (error) console.warn("Profile sync skipped:", error.message);
}

$("auth-toggle").addEventListener("click", () => {
  signupMode = !signupMode;
  $("auth-title").textContent = signupMode ? "Create account" : "Sign in";
  $("auth-subtitle").textContent = signupMode ? "Set up your private workspace." : "Access your private workspace.";
  $("auth-submit").innerHTML = signupMode ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  $("auth-toggle").textContent = signupMode ? "Already registered? Sign in" : "New here? Create an account";
  $("password").autocomplete = signupMode ? "new-password" : "current-password";
  message("auth-message");
});

$("sign-out").addEventListener("click", async () => { await supabase.auth.signOut(); session = null; showAuth(); });
$("show-create").addEventListener("click", () => { $("create-form").hidden = false; $("bot-name").focus(); });
$("cancel-create").addEventListener("click", () => { $("create-form").hidden = true; message("create-message"); });

$("create-form").addEventListener("submit", async event => {
  event.preventDefault(); message("create-message", "Creating bot…");
  const { data, error } = await supabase.from("bot_instances").insert({ owner_id:session.user.id, bot_name:$("bot-name").value.trim(), prefix:$("bot-prefix").value, mode:$("bot-mode").value, status:"not_connected" }).select().single();
  if (error) return message("create-message", error.message);
  $("create-form").reset(); $("bot-prefix").value = "."; $("create-form").hidden = true;
  message("global-message", "Bot instance created successfully.");
  await loadBots();
});

$("bot-list").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest("[data-bot]"), botId = card.dataset.bot, action = button.dataset.action;
  const box = card.querySelector("[data-pair-box]");
  button.disabled = true; message("global-message", "Working…");
  try {
    if (action === "status") {
      const result = await refreshOne(card);
      message("global-message", `Current status: ${result.status}`);
    } else if (action === "pair") {
      const phone = window.prompt("Enter the WhatsApp number in international format, e.g. +2547XXXXXXXX:");
      if (!phone) return;
      const result = await requestBotPairingCode(botId, phone.trim(), token());
      box.hidden = false; box.innerHTML = `<div class="eyebrow">LINK DEVICE</div><div class="pair-code">${escapeHtml(result.code || "Code unavailable")}</div><p class="muted">On WhatsApp, open Linked devices → Link a device → Link with phone number, then enter this code. Keep this code private.</p>`;
      await refreshOne(card);
      message("global-message", "Pairing code generated. Complete linking on your WhatsApp phone.");
    } else if (action === "reconnect") {
      const result = await reconnectBot(botId, token()); message("global-message", `Reconnect request: ${result.status || "accepted"}`);
      await refreshOne(card);
    } else if (action === "disconnect") {
      await disconnectBot(botId, token()); await refreshOne(card); message("global-message", "Bot disconnected. Automatic reconnect is disabled.");
    }
  } catch (error) { message("global-message", error.message || "Action failed."); }
  finally { button.disabled = false; }
});

async function boot() {
  if (!supabase) { message("auth-message", "Setup required: configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."); return; }
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (session) {
    showDashboard();
    try { await loadBots(); } catch (error) { message("global-message", error.message); }
  }
  supabase.auth.onAuthStateChange(async (_event, newSession) => {
    session = newSession;
    if (!session) { showAuth(); return; }
    showDashboard();
    try { await ensureProfile(); await loadBots(); } catch (error) { message("global-message", error.message); }
  });
}
boot();
