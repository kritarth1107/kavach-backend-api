# Saheli private browser (Instinct-class) — 2026-09-24

Beat Instinct: **private Playwright profile per elder AND per caregiver**, Gemini multimodal computer-use, WhatsApp OTP paste + confirm-before-pay. Chat brain stays on the existing Gemini path — browsing AI is Vertex Gemini vision only (no Claude/OpenAI computer-use).

## Architecture

```
WhatsApp turn
  → browserTaskWhatsApp / pharmacyOrderFlow
  → runBrowserTask({ userId, goal, partner?, otp?, userConfirmed? })
  → getOrCreateBrowserProfile(familyId, userId)   # encrypted storageState
  → BrowserWorker (playwright | dry_run)
       → screenshot + a11y hint
       → planBrowserActions()  # Vertex gemini-3.5-flash multimodal
       → click|type|press|scroll|wait|goto|need_otp|need_user_confirm|done
  → WA reply (OTP ask / confirm card / done)
```

### A. Browser profile store

| Piece | Location |
|-------|----------|
| Mongo | `BrowserProfile` — unique `(familyId, userId)`, AES-GCM `encryptedStorageState` |
| Disk | `BROWSER_PROFILE_DIR` / `.saheli-browser-profiles/{familyId}/{userId}/storageState.json` |
| API | `getOrCreateBrowserProfile`, `saveBrowserProfileState`, `runBrowserTask` |

Works for **CARE_RECIPIENT and caregivers** (caregiver self-orders = personal assistant; no elder notify).

Encryption key: `COMMERCE_SESSION_ENCRYPTION_KEY` (64-hex or any string → sha256). Refuses to persist blob if unset.

### B. Playwright runner

| Mode | When |
|------|------|
| `playwright` | Chromium launches (`BROWSER_WORKER_MODE=playwright` or `auto` + local Chromium) |
| `dry_run` | Cloud Run alpine image / no Chromium — still drives WA OTP + confirm UX end-to-end |

Interface: `browserWorker.service.ts` (`BrowserWorker`). Cloud Run Dockerfile sets `BROWSER_WORKER_MODE=dry_run` and does **not** install Chromium (512Mi Cloud Run cannot host it reliably same-day). Local: `npm i && npx playwright install chromium`.

### C. Gemini computer-use loop

- Model: `VERTEX_BROWSER_MODEL` / `VERTEX_VISION_MODEL` / default **`gemini-3.5-flash`** @ `asia-south1`
- Tool schema: `click`, `type`, `press`, `scroll`, `wait`, `goto`, `done`, `need_otp`, `need_user_confirm`
- Max steps default 20 (cap 30)
- **Safety:** never submit payment without `need_user_confirm` resolved (`userConfirmed=true`). Pay-ish clicks are rewritten to confirm.

### D. Partner playbooks

| Partner | Start URL |
|---------|-----------|
| Apollo | https://www.apollopharmacy.in/ |
| Instamart | https://www.swiggy.com/instamart |
| PharmEasy / 1mg / Blinkit / Zepto | partner sites |
| Generic browse | Google — “open X / find Y” |

### E. WhatsApp UX

1. User: `order vit c from apollo` (elder or caregiver)
2. Saheli opens browser task → asks to **paste SMS OTP** (never reads device SMS)
3. After OTP → **confirm card** (item + total + address)
4. User: `confirm` → continue checkout (UPI: show what to tap if agent can’t complete alone)
5. Elder place → caregivers **notify-only**. Caregiver self-order → no elder notify.

## Prod vs local

| Surface | Live in prod (Cloud Run) after deploy? |
|---------|----------------------------------------|
| Per-user profile store + encryption | **Yes** |
| WA OTP + confirm state machine | **Yes** (dry_run worker) |
| Gemini action planner code path | **Yes** (called when Playwright screenshots exist) |
| Full Chromium Playwright on Cloud Run | **No** — dry_run stub; Chromium is local/dev until a dedicated browser job/sidecar ships |
| Apollo / Instamart / generic intents | **Yes** — enter browser/OTP/confirm flow (not “not supported”) |

## Smoke

### Unit / dry-run (no Mongo required for worker)

```bash
cd kavach-backend
BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-private-browser.ts
```

Expect: `order vit c from apollo` → `need_otp` → OTP → `need_user_confirm` → confirm → `done`. Never “not supported”.

### WhatsApp mock (with Mongo + running backend)

Send as elder/caregiver: `order vit c from apollo` → OTP prompt → paste `123456` → confirm card → `confirm`.

## Env

```
BROWSER_WORKER_MODE=auto|playwright|dry_run
BROWSER_PROFILE_DIR=
COMMERCE_SESSION_ENCRYPTION_KEY=
VERTEX_BROWSER_MODEL=gemini-3.5-flash
```

## Files

- `src/services/commerceAutomation/browserProfile.service.ts`
- `src/services/commerceAutomation/browserWorker.service.ts`
- `src/services/commerceAutomation/geminiComputerUse.service.ts`
- `src/services/commerceAutomation/browserTaskWhatsApp.service.ts`
- `src/services/commerceAutomation/playbooks.ts`
- `src/models/browserProfile.model.ts`
