import { createClient } from "@supabase/supabase-js";
import { getBotRuntimeStatus, requestBotPairingCode, reconnectBot, disconnectBot, isRuntimeConfigured } from "./runtime-client.js";
import "./style.css";

const config = window.CASTRO_X_MD_CONFIG || {};
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || config.supabaseUrl || "";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || config.supabaseAnonKey || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const $ = id => document.getElementById(id);
let session = null;
let bots = [];
let signupMode = false;
const pairingTimers = new Map();

function normalizeWhatsAppPhone(value) {
  let digits = String(value || "").split("").filter(ch => ch >= "0" && ch <= "9").join("");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) throw new Error("Enter an international number with country code, e.g. 254758102401 or 447700900123.");
  return `+${digits}`;
}
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
  if (status === "pairing" && result.pairingCode) renderPairingCode(card, result.pairingCode, result.pairingExpiresAt);
  if (status === "connected") clearPairingTimer(botId);
  return result;
}

function clearPairingTimer(botId) {
  const timer = pairingTimers.get(botId);
  if (timer) clearInterval(timer);
  pairingTimers.delete(botId);
}

function renderPairingCode(card, code, expiresAt) {
  const botId = card.dataset.bot;
  const box = card.querySelector("[data-pair-box]");
  const expiry = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 25_000;
  clearPairingTimer(botId);
  box.hidden = false;
  box.innerHTML = `
    <div class="eyebrow">CASTRO X MD · PAIRING CODE</div>
    <div class="pair-code">${escapeHtml(code || "Code unavailable")}</div>
    <p class="muted">On your phone, open WhatsApp → Linked devices → Link a device → Link with phone number. Enter this code there. Never share it with anyone.</p>
    <p class="notice" data-pair-countdown role="status"></p>
    <div class="actions" data-expired-action hidden><button class="primary" type="button" data-action="pair">Request a new code</button></div>
  `;
  const countdown = box.querySelector("[data-pair-countdown]");
  const expiredAction = box.querySelector("[data-expired-action]");
  const tick = () => {
    const remaining = Math.max(0, expiry - Date.now());
    if (remaining <= 0) {
      countdown.textContent = "This pairing code has expired. Request a new code to continue.";
      expiredAction.hidden = false;
      clearPairingTimer(botId);
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    countdown.textContent = `Enter this code in WhatsApp within ${seconds} second(s).`;
  };
  tick();
  if (expiry > Date.now()) pairingTimers.set(botId, setInterval(tick, 1000));
}

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase) return message("auth-message", "Dashboard configuration is missing. Set Supabase URL and publishable/anon key.");
  const button = $("auth-submit"); button.disabled = true; message("auth-message", "Please wait…");
  try {
    const email = $("email").value.trim(), password = $("password").value;
    const result = signupMode
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (signupMode && !result.data.session) {
      message("auth-message", "Account created. Check your email to confirm, then return here and sign in.");
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
  // profiles has id/display_name columns; email belongs to auth.users, not profiles.
  const { error } = await supabase.from("profiles").upsert({ id:session.user.id }, { onConflict:"id" });
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
  event.preventDefault();
  const submit = $("create-form").querySelector('button[type="submit"]');
  if (!session?.user) { message("create-message", "Your session has expired. Sign out and sign in again."); return; }
  submit.disabled = true;
  submit.textContent = "Creating…";
  message("create-message", "Saving your bot instance…");
  message("global-message");
  try {
    const payload = {
      owner_id: session.user.id,
      bot_name: $("bot-name").value.trim(),
      prefix: $("bot-prefix").value.trim() || ".",
      mode: $("bot-mode").value,
      status: "not_connected"
    };
    const { data, error } = await supabase.from("bot_instances").insert(payload).select("id,bot_name,prefix,mode,status,created_at").single();
    if (error) throw error;
    bots.unshift(data);
    $("create-form").reset();
    $("bot-prefix").value = ".";
    $("create-form").hidden = true;
    await loadBots();
    message("global-message", "Bot instance created successfully. It is not connected to WhatsApp yet.");
  } catch (error) {
    console.error("Bot creation failed:", error);
    const detail = error?.message || error?.details || error?.hint || "Unknown database or network error.";
    message("create-message", `Could not create bot: ${detail}`);
  } finally {
    submit.disabled = false;
    submit.textContent = "Create instance";
  }
});

$("bot-list").addEventListener("submit", async event => {
  const form = event.target.closest("form[data-pair-form]");
  if (!form) return;
  event.preventDefault();
  const card = form.closest("[data-bot]");
  const botId = card.dataset.bot;
  const rawPhone = form.elements.phone.value.trim();
  const submit = form.querySelector('button[type="submit"]');
  const status = form.querySelector("[data-pair-message]");
  submit.disabled = true;
  status.textContent = "Requesting a secure pairing code…";
  try {
    const result = await requestBotPairingCode(botId, normalizeWhatsAppPhone(rawPhone), token());
    renderPairingCode(card, result.code, result.pairingExpiresAt);
    await refreshOne(card);
    message("global-message", "Pairing code generated. Finish linking inside WhatsApp on your phone.");
  } catch (error) {
    status.textContent = error.message || "Could not request a pairing code.";
    submit.disabled = false;
  }
});

$("bot-list").addEventListener("click", async event => {
  const cancelPair = event.target.closest("[data-pair-cancel]");
  if (cancelPair) {
    const box = cancelPair.closest("[data-pair-box]");
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
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
      box.hidden = false;
      box.innerHTML = `
        <div class="eyebrow">CONNECT YOUR WHATSAPP</div>
        <p class="muted">Enter the WhatsApp number for this bot. Use international format, including the country code.</p>
        <form data-pair-form class="pair-form">
          <label>WhatsApp phone number
            <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+2547XXXXXXXX" pattern="\\+[1-9][0-9]{7,14}" required>
          </label>
          <div class="actions"><button class="primary" type="submit">Get pairing code</button><button class="outline" type="button" data-pair-cancel>Cancel</button></div>
          <p class="notice" data-pair-message role="status"></p>
        </form>`;
      message("global-message", "Enter the WhatsApp number in the form inside your bot card.");
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
    try {
      await loadBots();
      if (!isRuntimeConfigured()) message("global-message", "WhatsApp controls are ready in the dashboard, but the persistent runtime has not been deployed or configured yet.");
      else await refreshAllStatuses();
    } catch (error) { message("global-message", error.message); }
  }
  supabase.auth.onAuthStateChange(async (_event, newSession) => {
    session = newSession;
    if (!session) { showAuth(); return; }
    showDashboard();
    try {
      await ensureProfile();
      await loadBots();
      if (!isRuntimeConfigured()) message("global-message", "WhatsApp controls are ready in the dashboard, but the persistent runtime has not been deployed or configured yet.");
      else await refreshAllStatuses();
    } catch (error) { message("global-message", error.message); }
  });
}

async function refreshAllStatuses() {
  if (!session || !isRuntimeConfigured()) return;
  const cards = [...document.querySelectorAll("[data-bot]")];
  await Promise.allSettled(cards.map(card => refreshOne(card)));
}

setInterval(() => { refreshAllStatuses().catch(error => console.warn("Background status refresh failed:", error)); }, 15000);
boot();
