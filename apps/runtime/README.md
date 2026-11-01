# CASTRO X MD — WhatsApp Runtime

This is the persistent Node.js service for WhatsApp Web sessions. The dashboard stays on Vercel; this process must run on a host with persistent storage.

## Required environment
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-side secret only.
- `SESSION_ENCRYPTION_KEY` — stable random secret, at least 32 bytes. Losing it makes existing encrypted sessions unrecoverable.
- `SESSION_DIR` — persistent private disk mount (default: `/var/lib/castro-x-md/sessions`).
- `DASHBOARD_ORIGINS` — comma-separated exact allowed browser origins.
- `PORT` (optional; defaults to 8080).

## API
- `GET /health` process liveness.
- `GET /ready` database readiness.
- `GET /api/bots/:botId/status` authenticated owner status.
- `POST /api/bots/:botId/pair` authenticated pairing-code request; JSON body: `{"phone":"+2547XXXXXXXX"}`.
- `POST /api/bots/:botId/disconnect` authenticated disconnect.

All API routes except health/readiness require a valid Supabase access token. Bot ownership is checked against `bot_instances.owner_id`. Pairing codes are never exposed through public status routes.

## Security and operating limits
Per-bot auth state is encrypted with AES-256-GCM. Mount a persistent disk and back it up securely. Never put the service-role key or encryption key in browser variables or Git. Baileys is an unofficial WhatsApp Web integration; account restrictions are possible. Test with a disposable number first. No spam, privacy bypass, view-once circumvention, or unsolicited bulk messaging.

## Release status
Early integration build, not production-certified. Before real accounts are used, run the CI checks and end-to-end tests, verify Baileys pairing on a disposable number, configure persistent disk and secrets, and test recovery after a forced restart. Multi-process locking and automated restoration after host replacement remain release blockers; run only one runtime replica until those protections are implemented.
