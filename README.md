# CASTRO X MD

CASTRO X MD is a Node.js WhatsApp bot project. The bot runtime currently starts from the repository-root `index.js`.

## Requirements

- Node.js 24 or newer
- npm 10 or newer
- A persistent server/container for the WhatsApp process
- A WhatsApp account that you control

## Local setup

1. Clone this repository.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env` or configure the variables in your hosting provider.
4. Set your own `OWNER_NUMBER` and other required settings. Use international format without a leading plus sign.
5. Start the bot with `npm start`.

Do not commit `.env`, `config.env`, WhatsApp credentials, session folders, or API keys.

## Configuration

The sample environment file contains the supported configuration names and safe defaults. Set owner-specific values yourself; this repository intentionally does not ship with another person's WhatsApp number as the default owner.

## Deployment notes

The Dockerfile uses Node.js 24 and copies the repository-root runtime files, matching the current `index.js` entry point and `npm start` script.

**Important:** WhatsApp authentication data must be stored on persistent storage supplied by the hosting platform. A normal ephemeral container filesystem can lose sessions during redeployments or restarts. Confirm the bot's actual authentication storage path and mount a persistent disk there before treating a deployment as production-ready.

Vercel is suitable for the web dashboard, not for running the always-on WhatsApp socket process. Run the bot process on a persistent Node.js host or VPS.

## Project status

Pairing, reconnect behavior, multi-user session isolation, dashboard-to-runtime integration, and production uptime still require end-to-end verification against a real WhatsApp account. A successful build alone does not prove that WhatsApp pairing or session persistence works.
