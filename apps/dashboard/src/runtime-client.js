const runtimeBase = String(import.meta.env?.VITE_RUNTIME_API_URL || window.CASTRO_X_MD_RUNTIME_URL || "").replace(/\/$/, "");

function requireRuntime() {
  if (!runtimeBase) throw new Error("Runtime API URL is not configured yet.");
  return runtimeBase;
}

async function request(path, accessToken, options = {}) {
  if (!accessToken) throw new Error("Your login session has expired. Please sign in again.");
  const response = await fetch(`${requireRuntime()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Runtime request failed (${response.status})`);
  return payload;
}

export function getBotRuntimeStatus(botId, accessToken) {
  return request(`/api/bots/${encodeURIComponent(botId)}/status`, accessToken);
}

export function requestBotPairingCode(botId, phone, accessToken) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error("Enter the phone number in international format, e.g. +2547XXXXXXXX.");
  }
  return request(`/api/bots/${encodeURIComponent(botId)}/pair`, accessToken, {
    method: "POST",
    body: JSON.stringify({ phone })
  });
}

export function reconnectBot(botId, accessToken) {
  return request(`/api/bots/${encodeURIComponent(botId)}/reconnect`, accessToken, { method: "POST", body: "{}" });
}

export function disconnectBot(botId, accessToken) {
  return request(`/api/bots/${encodeURIComponent(botId)}/disconnect`, accessToken, { method: "POST", body: "{}" });
}
