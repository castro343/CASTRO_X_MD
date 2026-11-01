# CASTRO X MD — WhatsApp Runtime

Runs separately from Vercel because WhatsApp Web sockets need a persistent Node process and durable private storage.

## Environment
Configure all values from `.env.example` in the host's secret settings:
- `SUPABASE_SERVICE_ROLE_KEY`: server-only; never put it in browser code or Git.
- `SESSION_ENCRYPTION_KEY`: stable secret of at least 32 characters. Losing/changing it prevents decrypting existing sessions.
- `SESSION_DIR`: private persistent disk mount; back it up securely.
- `DASHBOARD_ORIGINS`: exact dashboard origin.

## Safety
Per-bot auth state is encrypted with AES-256-GCM in a private directory derived from the bot ID. Pairing codes are returned only after authenticated ownership checks. Baileys is an unofficial WhatsApp Web integration; account restrictions are possible. Test with a disposable number first. No spam, privacy bypass, view-once circumvention, or unsolicited bulk messaging.

## Release status
Foundation only, not production-certified. Before live use, verify the pinned Baileys API with dependency audits and end-to-end tests; add restart restoration, durable multi-process locks, command handlers, monitoring, and backups.
