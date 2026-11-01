# Dashboard runtime client

The module in `src/runtime-client.js` provides authenticated browser calls for pairing, status, reconnect, and disconnect.

Configure the public runtime base URL as `VITE_RUNTIME_API_URL` at build time (or set `window.CASTRO_X_MD_RUNTIME_URL` before importing the module). Never place Supabase service-role credentials or the runtime session-encryption key in dashboard variables.

Each call requires the signed-in user's Supabase access token. The runtime verifies the token and checks that the requested bot belongs to that user.

The client is an integration module, not a complete dashboard deployment. Pairing cannot work until a persistent runtime host is deployed, its URL is configured, and that dashboard origin is included in the runtime's `DASHBOARD_ORIGINS`.
