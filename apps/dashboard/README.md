# CASTRO X MD Dashboard

This is the browser dashboard for the multi-user WhatsApp automation workspace. It includes Supabase email/password authentication, private bot listing, bot creation, and WhatsApp pairing/status/reconnect/disconnect controls.

## Build configuration

Copy the values from `.env.example` into the Vercel project's environment variables:

- `VITE_SUPABASE_URL` — Supabase project URL.
- `VITE_SUPABASE_ANON_KEY` — Supabase publishable key (or legacy anon key). Never use the service-role key here.
- `VITE_RUNTIME_API_URL` — base URL of the persistent WhatsApp runtime.

The dashboard can be built with `npm run build`. Vercel should use `apps/dashboard` as the Root Directory, with the default Vite build output `dist`.

## WhatsApp controls

Each bot card can request a pairing code, refresh its connection status, reconnect a previously paired session, or disconnect it. Status is refreshed every 15 seconds while the dashboard is open. Pairing requires the runtime to be deployed on a persistent host and the dashboard origin to be included in the runtime's `DASHBOARD_ORIGINS` allowlist.

The runtime verifies each Supabase access token and checks bot ownership before acting. Pairing codes are sensitive: enter them only in the WhatsApp app's official Linked devices flow and do not share them.

## Security and release status

Never expose Supabase service-role credentials or the runtime encryption key in browser variables. This dashboard is an integration build, not a production-certified release. Before using a real WhatsApp account, verify email confirmation/redirect settings, runtime CORS, persistent encrypted session storage, and end-to-end pairing on a disposable WhatsApp number. Baileys is an unofficial WhatsApp Web integration and account restrictions are possible.
