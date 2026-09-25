# Saheli commerce smoke — tomorrow checklist (2026-09-25 → 2026-09-26 IST)

**Goal:** User smoke of SHARED commerce pipeline across pharmacy + grocery/food.  
**Do not** use Hermes. Prefer mock WA first; live Meta WA only if Meta delivery is healthy.  
**Phone:** `<test-elder-number>` / `<test-elder-number>` — OTP SMS may be sent by partner sites when login is enabled; paste into WA only after Saheli asks.

**Default delivery (when elder has none saved):**  
`<recipient saved address>`  
Always **confirm-before-pay**; prefer **COD**.

**Flags (Cloud Run):**
| Env | Expected for smoke |
|-----|-------------------|
| `COMMERCE_BROWSER_FIRST` | `1` (MCP kept for flip-back) |
| `BROWSER_WORKER_MODE` | `auto` (live Chromium) |
| `BROWSER_PHARMACY_LOGIN` | **`on`** for live OTP; leave `off` only to dry-run login UI without SMS |
| Residential / proxy | Use later if partner bot-walls Cloud Run IP |

**Mock webhook:**
```bash
POST https://kavach-backend-303943038694.asia-south1.run.app/api/webhooks/whatsapp/mock
Content-Type: application/json
{"from":"<test-elder-number>","text":"..."}
```
Space turns ~2.5–3s ( ~5s after guest search).

---

## Shared pattern (all partners)

1. **Search first** (guest/MCP) → WA exact SKU + ₹ (or honest “no guest price”).
2. Reply `1`/`2`/`3` or `confirm` → **then** login/OTP.
3. Paste OTP **only after** Saheli asks (Sent-to only when generateOtp confirmed).
4. Browser stays up → search/cart/address → **confirm-before-pay** (prefer COD).
5. Bare `status` mid-flow must **not** steal *Latest Instamart order*.
6. `cancel` clears parked OTP + drafts; no more OTP asks from that attempt.

---

## Per-partner checklist

### Pharmacy

| Partner | Guest search? | OTP path | Post-login | Smoke steps | Expected WA |
|---------|---------------|----------|------------|-------------|-------------|
| **Apollo** | Yes (public API) | Deterministic bootstrap; Sent-to only on generateOtp match | Park Chromium → cart → confirm | `order vitamin c from apollo` → pick Limcee/#1 → `confirm` → wait ask → paste OTP → confirm COD | Found + ₹ before login; no false Sent-to; COD confirm |
| **PharmEasy** | Yes (public API) | Same discipline | Same | `order vitamin c from pharmeasy` → confirm → OTP → COD | Guest hits (Limcee merge); honest if empty |
| **Tata 1mg** | No guest ₹ (honest) | Browser login after confirm | Same | `order vitamin c from 1mg` → `confirm` opens site | Copy says no guest price; no invented ₹ |

Refuse: `order iphone from apollo` → medicines-only redirect (amazon/flipkart).

### Grocery / food (browser-first)

| Partner | Guest / MCP search? | OTP path | Post-login | Smoke steps | Expected WA |
|---------|---------------------|----------|------------|-------------|-------------|
| **Instamart** | MCP when connected; else honest | Browser login + login_phone from WA | Keep Chromium; cart; confirm COD | `order milk from instamart` → confirm → OTP if asked | awaiting_sku_confirm first; address shown |
| **Swiggy** | MCP when connected; else honest | Same | Same | `order paneer butter masala from swiggy` | Food playbook; confirm-before-pay |
| **Zepto** | MCP when connected; else honest | Same | Same | `order bread from zepto` | Same template |
| **Blinkit** | No guest API (403); honest | Browser after confirm | Same | `order milk from blinkit` → `confirm` | Honest no-guest-price; then browser |
| **Zomato** | No guest API; honest | Browser after confirm | Same | `order pizza from zomato` → `confirm` | Honest no-guest-price; then browser |

MCP adapters remain for flip-back (`COMMERCE_BROWSER_FIRST=0`).

---

## Status mid-flight

While `pharmacyDraft` or `browserTaskDraft` is `awaiting_sku_confirm` / `running` / `awaiting_otp` / `awaiting_confirm`:

- `status` / `ok` / `1`/`2`/`3` / `confirm` / `cancel` → commerce handler  
- Must **not** return dashboard “Latest Instamart order”

---

## When to use residential later

- CAPTCHA / bot wall / `access denied` from partner on Cloud Run IP  
- Login UI never appears (`no_login_button` / `site_slow` after retries)  
- OTP generate succeeds in API but SMS never arrives repeatedly (carrier/throttle) — retry later or residential egress

---

## Pre-smoke ops

1. Deploy this SHA to Cloud Run (`main`).
2. Confirm `BROWSER_PHARMACY_LOGIN=on` if live OTP is intended.
3. One mock `cancel` on `<test-elder-number>` if a parked session might still be open.
4. Do **not** fire OTP against the phone during deploy-only tasks.

## Out of scope tonight

- Live OTP / COD / WhatsApp smoke against `<test-elder-number>`  
- Hermes  
- LLM stack changes  
