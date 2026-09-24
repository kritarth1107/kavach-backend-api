# Saheli ride booking (Instinct-parity) — 2026-09-24

Uber-first private-browser rides on WhatsApp: slot-fill pickup/drop (text + location pin), route confirm, OTP paste, **confirm-before-book**, driver/car/plate. Fits the existing commerce private-browser + OTP patterns — does not change companion LLM / `VERTEX_*` / `LLM_PROVIDER`.

## Flow

```
Elder: "book a cab" / "want a ride" / "Yeah" (after ride offer)
  → "Where from, and where to?"
  → text place and/or WhatsApp LOCATION PIN
  → resolve addresses (geocode / reverse)
  → "Got the route: from … to …."
  → "Is your Uber account on this number (+91…)? If yes, Uber will send a 4-digit code — forward it here."
  → paste OTP
  → fare + ride type card → reply *book* / *confirm*
  → driver / car / plate
  → caregivers notify-only (elder rides)
Cancel: Nope / cancel / never mind → clear session; nothing booked/paid
```

Hang safety (same as commerce):

- `BROWSER_TASK_DEADLINE_MS` ~28s on browser tasks
- WhatsApp reply SLA (`WHATSAPP_REPLY_SLA_MS` ~35s) with progress fallback
- Uber login kicked **async** after phone confirm — immediate OTP ask (no forever typing)

## Architecture

| Piece | Location |
|-------|----------|
| WA state machine | `src/services/rideBooking/rideWhatsApp.service.ts` |
| Slot / pin parsers | `src/services/rideBooking/slotParse.ts` |
| Geo resolve | `src/services/rideBooking/geoResolve.service.ts` |
| Browser goal + dry-run fares | `src/services/rideBooking/rideBrowser.service.ts` |
| Uber playbook | `src/services/commerceAutomation/playbooks.ts` (`uber`) |
| Dry-run ride path | `browserWorker.service.ts` (`BOOK_RIDE` / partner uber) |
| Session draft | `WhatsappSession.rideDraft` |
| AI tools | `book_ride`, `ride_status`, `cancel_ride` |

Browser worker: existing per-(familyId, userId) encrypted Playwright profile. Start URL: `https://m.uber.com/`. `BROWSER_WORKER_MODE=auto|playwright|dry_run` unchanged.

## Geo

Order of preference (no invented keys):

1. `GOOGLE_MAPS_API_KEY` or `GOOGLE_GEOCODING_API_KEY`
2. `MAPBOX_ACCESS_TOKEN`
3. Nominatim / OpenStreetMap (User-Agent set; best-effort)

WhatsApp location messages are encoded as:

`[location lat=12.97 lng=77.59 name="…" address="…"]`

## Env

```
BROWSER_WORKER_MODE=auto|playwright|dry_run
BROWSER_TASK_DEADLINE_MS=28000
WHATSAPP_REPLY_SLA_MS=35000
GOOGLE_MAPS_API_KEY=          # optional
MAPBOX_ACCESS_TOKEN=          # optional
COMMERCE_SESSION_ENCRYPTION_KEY=
```

## Smoke

```bash
cd kavach-backend
BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-rides.ts
```

Expect: intent → from/to ask → pin+text route confirm → OTP → fare confirm → book → driver stub; cancel clears; bare Yeah asks slots.

## Deferred (phase 2)

- Full Ola / Rapido web playbooks (stubs exist; Uber first is v1)
- Deep geo-fallback research (GoaMiles / TaxiBazaar) when Uber unavailable — v1 says so cleanly
- Live Chromium scrape hardening for Uber DOM changes
- Caregiver-initiated rides for elder (notify path exists; booking-from-caregiver UX TBD)

## Files

- `src/services/rideBooking/*`
- `src/services/commerceAutomation/playbooks.ts` / `types.ts` / `siteResolve.ts` / `adapters.ts` / `browserWorker.service.ts`
- `src/services/whatsappRouting.service.ts` / `whatsappInbound.service.ts`
- `src/clients/metaWhatsApp.client.ts` (location extract)
- `src/models/whatsappSession.model.ts` (`rideDraft`)
- `src/services/saheliTools.service.ts` (`book_ride` / `ride_status` / `cancel_ride`)
- AI engine: `app/agents/tools.py`, `prompts.py`, `caregiver_agent.py`
