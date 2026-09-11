# WhatsApp Baileys bridge (MVP pilot)

Until Meta Business WhatsApp is approved, Kavach can use a **Baileys sidecar** for a closed pilot.

## Architecture

```
Parent WhatsApp  →  kavach-baileys-bridge  →  POST /api/webhooks/whatsapp/baileys
                                                      ↓
                                               sendSaheliMessage (same as dashboard)
                                                      ↓
Outbound outreach ←  POST bridge /v1/send  ←  channelOutbound.service
```

## Setup

### 1. Backend (`kavach-backend`)

Add to `.env`:

```env
WHATSAPP_PROVIDER=baileys
WHATSAPP_BRIDGE_URL=http://localhost:3100
WHATSAPP_BRIDGE_SECRET=your-shared-secret
```

### 2. Bridge (`kavach-baileys-bridge`)

```bash
cd kavach-baileys-bridge
cp .env.example .env
npm install
npm run dev
```

Scan the QR code with a **dedicated pilot SIM** (not a personal daily driver).

### 3. Link phone numbers

Each pilot user needs a `ChannelIdentity` row (`channelType: whatsapp`) matching their WhatsApp number. The seed script or Family settings must map `+919XXXXXXXXX` → user.

## Endpoints

| Service | Endpoint | Auth |
|---------|----------|------|
| Bridge → Backend | `POST /api/webhooks/whatsapp/baileys` | `X-Kavach-Bridge-Secret` |
| Backend → Bridge | `POST /v1/send` `{ to, text }` | `X-Kavach-Bridge-Secret` |
| Bridge health | `GET /health` | none |

## Migration to Meta Cloud API

Set `WHATSAPP_PROVIDER=mock` (or future `cloud`) and implement `WhatsAppCloudAdapter` — Saheli logic stays unchanged.

## Pilot warnings

- Unofficial API — number can be banned by Meta
- For opt-in pilot families only
- Do not use for production marketing or scale
