# Saheli ride booking (Instinct-parity) — 2026-09-24

Uber-first private-browser rides on WhatsApp: slot-fill pickup/drop (text + location pin), route confirm, OTP paste, **confirm-before-book**, driver/car/plate. Fits the existing commerce private-browser + OTP patterns — does not change companion LLM / `VERTEX_*` / `LLM_PROVIDER`.

## Live status (go-live)

**Production path is LIVE** when `BROWSER_WORKER_MODE=auto` (or `playwright`) and Chromium launches on Cloud Run — real `m.uber.com` interactions for login OTP, fare scrape, and book-on-confirm. Dry-run stubs are only used when mode is forced `dry_run` or Chromium cannot launch (local/CI without browser).

- Confirm-before-book remains **mandatory** (WhatsApp `book`/`confirm` + Gemini/playwright gate on Request/Book clicks).
- Cancel clears the ride draft; nothing booked/paid.
- Commerce grocery/pharmacy behavior unchanged (same `BROWSER_WORKER_MODE`).

## Flow

```
Elder: "book a cab" / "want a ride" / "Yeah" (after ride offer)
  → "Where from, and where to?"
  → text place and/or WhatsApp LOCATION PIN
  → resolve addresses (geocode / reverse)
  → "Got the route: from … to …."
  → "Is your Uber account on this number (+91…)? If yes, Uber will send a 4-digit code — forward it here."
  → paste OTP
  → fare + ride type card (live scrape) → reply *book* / *confirm*
  → driver / car / plate (live scrape) or clear error (CAPTCHA / geo / block)
  → caregivers notify-only (elder rides)
Cancel: Nope / cancel / never mind → clear session; nothing booked/paid
```

Hang safety (same as commerce):

- `BROWSER_TASK_DEADLINE_MS` ~28s on browser tasks (book confirm may use up to ~40–60s)
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
| Live Playwright + block detect | `browserWorker.service.ts` (mobile UA for rides, CAPTCHA/geo errors) |
| Session draft | `WhatsappSession.rideDraft` |
| AI tools | `book_ride`, `ride_status`, `cancel_ride` |

Browser worker: existing per-(familyId, userId) encrypted Playwright profile. Start URL: `https://m.uber.com/`. `BROWSER_WORKER_MODE=auto|playwright|dry_run` — no ride-only force-dry flag.

## Geo

Order of preference (no invented keys):

1. `GOOGLE_MAPS_API_KEY` or `GOOGLE_GEOCODING_API_KEY`
2. `MAPBOX_ACCESS_TOKEN`
3. Nominatim / OpenStreetMap (User-Agent set; best-effort)

WhatsApp location messages are encoded as:

`[location lat=12.97 lng=77.59 name="…" address="…"]`

## Env

```
BROWSER_WORKER_MODE=auto|playwright|dry_run   # prod Cloud Run: auto (Chromium in image)
BROWSER_TASK_DEADLINE_MS=28000
WHATSAPP_REPLY_SLA_MS=35000
GOOGLE_MAPS_API_KEY=          # optional
MAPBOX_ACCESS_TOKEN=          # optional
COMMERCE_SESSION_ENCRYPTION_KEY=
```

Deploy workflow sets `BROWSER_WORKER_MODE=auto` on `kavach-backend` (project `kavach-care`). Dockerfile also defaults `BROWSER_WORKER_MODE=auto`.

## Smoke

### CI / local dry-run (no charge)

```bash
cd kavach-backend
BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-rides.ts
```

Expect: intent → from/to ask → pin+text route confirm → OTP → fare confirm → book → driver stub; cancel clears; bare Yeah asks slots.

### WhatsApp live smoke (user; may incur a real Uber trip if you confirm)

1. Message Kavach Saheli WA from a number that has an Uber account.
2. `book a cab` → send pickup + drop (text and/or location pin) → `yes` on route.
3. `yes` on Uber-on-this-number → wait for Uber SMS OTP → paste the 4-digit code.
4. Expect a **live fare card** (real ₹ estimates, not the dry-run ₹180–220 stubs).
5. **Stop here for a free check** — reply `cancel` and confirm nothing was booked.
6. Full book smoke: reply `book` / `confirm` only if you accept a real paid trip; expect driver/car/plate or a clear CAPTCHA/geo error. Cancel in Uber app if needed.

Health check after deploy: `GET /api/health` → `browserWorker.modeEnv` is `auto` or `playwright`.

## Risks / known issues

- **CAPTCHA / bot walls** on m.uber.com from Cloud Run IPs → clear error; book in Uber app.
- **Uber ToS / automation** — private-browser automation may be restricted; treat as best-effort caregiver assist, not a guaranteed API.
- **OTP** — user must forward SMS; we never read device SMS. Wrong/expired OTP → retry or cancel.
- **Geo / no cars** — area unavailable surfaces a clean error; Ola/Rapido/GoaMiles deferred.
- **DOM drift** — Gemini computer-use may miss fare/driver selectors after Uber UI changes.
- **Confirm-before-book** must stay on; never auto-pay or auto-request without WhatsApp confirm.

## Deferred (phase 2)

- Full Ola / Rapido web playbooks (stubs exist; Uber first is v1)
- Deep geo-fallback research (GoaMiles / TaxiBazaar) when Uber unavailable
- Caregiver-initiated rides for elder (notify path exists; booking-from-caregiver UX TBD)
- Stronger fare DOM scrapers independent of Gemini when playbook selectors stabilize

## Files

- `src/services/rideBooking/*`
- `src/services/commerceAutomation/playbooks.ts` / `types.ts` / `siteResolve.ts` / `adapters.ts` / `browserWorker.service.ts` / `geminiComputerUse.service.ts`
- `src/services/whatsappRouting.service.ts` / `whatsappInbound.service.ts`
- `src/clients/metaWhatsApp.client.ts` (location extract)
- `src/models/whatsappSession.model.ts` (`rideDraft`)
- `src/services/saheliTools.service.ts` (`book_ride` / `ride_status` / `cancel_ride`)
- AI engine: `app/agents/tools.py`, `prompts.py`, `caregiver_agent.py`
