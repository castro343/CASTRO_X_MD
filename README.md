# CASTRO X MD

CASTRO X MD is a multi-user WhatsApp bot platform with a web dashboard and a separate persistent WhatsApp runtime.

## Project layout

- `apps/dashboard` — Vite dashboard intended for Vercel.
- `apps/runtime` — Node.js + Baileys API service. This must run continuously on a persistent Node.js host or VPS.
- `supabase` — database schema and migrations (apply the migrations before connecting the runtime).

## Runtime requirements

- Node.js 22 or newer
- Supabase project URL
- Supabase service-role key (server-side only)
- Stable `SESSION_ENCRYPTION_KEY` containing at least 32 bytes
- Private Supabase Storage bucket for encrypted WhatsApp sessions
- Exact dashboard origin in `DASHBOARD_ORIGINS`

See [apps/runtime/README.md](apps/runtime/README.md) for the runtime API, environment variables, and security requirements.

## Dashboard requirements

Set `apps/dashboard` as the Vercel Root Directory. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_RUNTIME_API_URL` in the Vercel project. Never expose the Supabase service-role key or session encryption key to the browser.

See [apps/dashboard/README.md](apps/dashboard/README.md) for setup details.

## Deployment

The repository-root Dockerfile builds the dedicated service in `apps/runtime`. The WhatsApp process must run on a persistent host; Vercel is for the dashboard, not the always-on WhatsApp socket.

## Release status

This is an integration build, not a production-certified release. Pairing, recovery after forced restarts, Supabase migrations, dashboard integration, and real-account behavior must be tested end-to-end with a disposable WhatsApp account before production use. Baileys is an unofficial WhatsApp Web integration and WhatsApp account restrictions are possible.
