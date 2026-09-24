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
| `playwright` | Chromium launches (`BROWSER_WORKER_MODE=playwright` or `auto` + Chromium present) |
| `dry_run` | Forced via env, or `auto` when Chromium cannot launch — still drives WA OTP + confirm UX |

Interface: `browserWorker.service.ts` (`BrowserWorker`). Launch args always include `--no-sandbox` and `--disable-dev-shm-usage` (Cloud Run).

**Safety unchanged:** never submit payment without `need_user_confirm` resolved (`userConfirmed=true`). Pay-ish clicks are rewritten to confirm. No silent pay.

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

## Prod Chromium on Cloud Run (live)

As of the prod-chromium enablement commit:

| Surface | Live in prod (Cloud Run)? |
|---------|---------------------------|
| Per-user profile store + encryption | **Yes** |
| WA OTP + confirm state machine | **Yes** |
| Gemini action planner | **Yes** (screenshots from real Chromium) |
| Full Chromium Playwright on Cloud Run | **Yes** — image installs Chromium via `npx playwright install --with-deps chromium` |
| Confirm-before-pay / no silent pay | **Yes** (enforced in worker) |

### Image & deploy

- **Base:** `node:22-bookworm-slim` (not alpine) — OS libs for Chromium.
- **Browsers path:** `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`
- **Default env in image + deploy:** `BROWSER_WORKER_MODE=auto` (falls back to dry_run only if launch fails)
- **Cloud Run resources** (see `.github/workflows/deploy-gcp.yml`):
  - Memory **4Gi**, CPU **2**
  - **Concurrency=1** (one browser session per instance — recommended)
  - Timeout 300s, min-instances=1, max-instances=3
- Deploy uses `--update-env-vars` (merge) so existing secrets (ELEVENLABS, Meta tokens, etc.) are preserved; only listed keys change.

### Residual limits

- **Cold start:** first request after scale-from-zero (or first browser task) may probe Chromium; min-instances=1 mitigates most cold starts.
- **Memory:** Chromium is heavy — if OOM, bump to higher memory or split `kavach-browser-worker` service later.
- **Concurrency=1:** keeps one Playwright session per container; scale out with max-instances, not concurrency.
- **Ephemeral disk:** profile `storageState` is also encrypted in Mongo; local profile dir on Cloud Run is ephemeral unless a volume is attached.
- **Do not** place a real paid Apollo order in smoke tests — OTP/confirm UX only.

### Verify prod mode

```bash
# Public health includes configured browser mode
curl -fsS "$BACKEND_URL/api/health" | jq '.browserWorker'
# Expect: { "modeEnv": "auto", "note": "..." }

# Confirm Cloud Run env + resources
gcloud run services describe kavach-backend --region=asia-south1 --project=kavach-care \
  --format='yaml(status.latestReadyRevisionName,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources,spec.template.spec.containers[0].env)'

# Logs on first browser task: "Saheli browser worker mode: playwright"
```

Chromium binary presence in the image (build-time): under `/ms-playwright` after `playwright install chromium`.

## Smoke

### Unit / dry-run (no Mongo required for worker)

```bash
cd kavach-backend
BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-private-browser.ts
```

Expect: `order vit c from apollo` → `need_otp` → OTP → `need_user_confirm` → confirm → `done`. Never “not supported”.

### Local Playwright (optional)

```bash
npm i && npx playwright install chromium
BROWSER_WORKER_MODE=playwright npx tsx scripts/smoke-private-browser.ts   # still uses DryRunBrowserWorker class in that script
# For a real launch probe:
node -e "require('playwright').chromium.launch({headless:true,args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('chromium ok'))"
```

### WhatsApp mock (with Mongo + running backend)

Send as elder/caregiver: `order vit c from apollo` → OTP prompt → paste `123456` → confirm card → `confirm`. **Do not complete a real paid order in smoke.**

## Env

```
BROWSER_WORKER_MODE=auto|playwright|dry_run
BROWSER_PROFILE_DIR=
COMMERCE_SESSION_ENCRYPTION_KEY=
VERTEX_BROWSER_MODEL=gemini-3.5-flash
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright   # set in Cloud Run image
```

## Files

- `Dockerfile` — bookworm-slim + Playwright Chromium
- `.github/workflows/deploy-gcp.yml` — 4Gi / 2 CPU / concurrency=1 / `BROWSER_WORKER_MODE=auto`
- `src/services/commerceAutomation/browserProfile.service.ts`
- `src/services/commerceAutomation/browserWorker.service.ts`
- `src/services/commerceAutomation/geminiComputerUse.service.ts`
- `src/services/commerceAutomation/browserTaskWhatsApp.service.ts`
- `src/services/commerceAutomation/playbooks.ts`
- `src/models/browserProfile.model.ts`
- `src/services/health.service.ts` — `browserWorker.modeEnv` on `/api/health`
