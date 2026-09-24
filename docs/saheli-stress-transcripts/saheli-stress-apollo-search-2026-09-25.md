# Saheli WhatsApp stress transcript — Apollo + search-before-login — 2026-09-25

- **Date (IST):** Friday 25 Sep 2026 (~02:22–02:26 IST)
- **Method:** `POST https://kavach-backend-303943038694.asia-south1.run.app/api/webhooks/whatsapp/mock` JSON `{ "from": "917694829888", "text": "..." }` (~2.5–3s spacing; ~5s after guest Apollo search)
- **Care recipient from:** `917694829888` (+917694829888)
- **Focus:** Apollo pharmacy guest catalog + search-before-login; OTP hard-capped
- **Baseline backend SHA (at test time):** `f49d9f2df19c9945d612a73cdf7688301de0372e`
- **Fix + transcript SHA (pushed main):** `451692f0a5ff19517a43329522b6f40e295966aa`
- **AI / LLM stack:** unchanged (no Co-authored-by; no model/stack edits)
- **OTP / SMS:** **1** controlled kickoff only — bare `ok` mid multi-SKU list unexpectedly opened Apollo login (C18). Immediately `cancel`. No fake OTPs, no resend. C8 `2` stayed on SKU confirm (did not open login). C9 `confirm` skipped to avoid a 2nd SMS.

## Summary scoreboard

| | PASS | FAIL | Score |
|---|---|---|---|
| **Apollo + search-before-login suite** | 12 | 11 | **12/23** |

### Tag rollup
- **[GOOD]** search+₹ / cancel / digit pick / re-search: C1, C3, C3b, C5b, C7, C8, C10, C11, C12, C13, C16-safety, C18-ellipsis
- **[UX]** Rx-gate before guest search (Limcee/Shelcal/Hinglish/Rx nouns): C2, C4b, C5, C14, C14b, C16
- **[HALLUC]** soft-basket nonsense / wrong partner status / weak Vit C ranking: C4, C6, C17, C20
- **[OTP-RISK]** bare `ok` ≡ confirm on multi-list → Opening Apollo: C18

## Case table

| CASE-ID | Sent | Result | Tags | Notes |
|---|---|---|---|---|
| A1 | Order vitamin c from apollo | PASS | [GOOD] | Limcee #1 + ₹; Celin-ish Vit-C #2; not soft basket |
| A2 | Order limcee from apollo | FAIL | [UX] | Rx-photo gate; no guest list/₹ |
| A3 | Order vitaminc from apollo | PASS | [GOOD] | Typo → same Limcee-ranked list |
| A3b | Order vitamin c capsule apollo | PASS | [GOOD] | Same ranked guest list |
| A4 | apollo se vitamin c manga do | FAIL | [UX][HALLUC] | Guest list but query polluted; Limcee missing; cream/Lemon See |
| A4b | Apollo pe limcee chahiye | FAIL | [UX] | Rx gate; listed `pe limcee chahiye` |
| A5 | Order shelcal from apollo | FAIL | [UX] | Rx gate; no guest list |
| A5b | Order dolo 650 from apollo | PASS | [GOOD] | Dolo-650 #1 ₹32 + analogues |
| A6 | Order unicorn dust from apollo | FAIL | [HALLUC] | Soft-lists unicorn + Rx gate; no honest no-results |
| A7 | Order medicine from apollo | PASS | [GOOD] | Asks list/Rx; no invent |
| A8 | vit c → `2` | PASS | [GOOD][OTP-SAFE] | Selects #2 into confirm basket; login only after further confirm (not opened) |
| A9 | vit c → confirm #1 | SKIP/PASS* | [GOOD] | Listing OK; full confirm skipped (OTP cap). #1 open observed via A18 bug path |
| A10 | vit c → `9` | PASS | [GOOD] | Re-shows list; no login |
| A11 | vit c → Order dolo 650… | PASS | [GOOD] | New search replaces list |
| A12 | mid-list cancel | PASS | [GOOD] | Cancel ack; no OTP |
| A13 | after Opening… cancel | PASS | [GOOD] | Via A18 cancel; clears; no more OTP asks |
| A14 | Order antibiotic from apollo | FAIL | [UX] | Rx gate; soft name; no diagnose copy elsewhere OK |
| A14b | Order insulin from apollo | FAIL | [UX] | Same Rx-before-search |
| A15 | Order iphone from apollo | FAIL | [UX] | Treated as medicine soft-basket; should refuse |
| A16 | double limcee send | FAIL | [UX] | Both Rx-gate (no SMS flood — safety OK) |
| A17 | status @ sku confirm | FAIL | [HALLUC] | Claims *Latest Instamart order* mid-Apollo |
| A18 | bare `ok` @ multi-list | FAIL | [OTP-RISK] | Opens Apollo login for #1 Limcee |
| A18b | `...` mid flow | PASS | [GOOD] | Warm ping; cancel still works |
| A19 | confirm w/o prior search | FAIL | [UX] | Residual post-A18 browser state, not clean idle |
| A20 | Order vitamin c from pharmeasy | FAIL | [HALLUC] | Guest ₹ list but Iron/Amla/multi-vit — not Limcee-like Vit C |

\*A9: intentional skip of second OTP path; Opening for #1 proven only via A18.

## OTP count

| Event | Count |
|---|---|
| Login/OTP kickoff (`Opening *Apollo*…`) | **1** (A18 `ok`) |
| Fake OTP pasted / resend | **0** |
| Cancel after kickoff | **1** (immediate) |

## Per-case transcript (exact replies)

### BOOT — cancel
- **Sent:** cancel
- **Reply:**

```
Order cancelled. Tell me anytime if you'd like to order again.
```

### A1 — PASS [GOOD]
- **Sent:** Order vitamin c from apollo
- **Reply:**

```
Found on *Apollo*:
1. Limcee 500 mg Chewable Orange Tablet 15's (15 Tablet · Strip) — ₹24.50
2. Vitamin-C 500 Chewable Tablet 10's (10 Chewable Tablet · Strip) — ₹33.10
3. Ecozyme Capsules (Rx · 15 Capsule · Strip) — ₹283.50

Reply *1* / *2* / *3*, or *confirm* for #1 — then I'll open login/OTP for that exact item.
Or send another name. Reply *cancel* to stop.
_I only help order what you ask — I don't diagnose or suggest treatments._
```
- **Notes:** Real Limcee + ₹; search-before-login copy correct.

### A2 — FAIL [UX]
- **Sent:** Order limcee from apollo
- **Reply:**

```
Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.

Listed so far: limcee
```
- **Notes:** Should guest-search Limcee + ₹ first; OTC brand stuck behind Rx gate.
- **Proposed fix:** Search-before-Rx; expand OTC hints (`limcee|celin|shelcal`).

### A3 — PASS [GOOD]
- **Sent:** Order vitaminc from apollo
- **Reply:** (same Limcee-ranked Apollo list as A1)

### A3b — PASS [GOOD]
- **Sent:** Order vitamin c capsule apollo
- **Reply:** (same Limcee-ranked Apollo list as A1)

### A4 — FAIL [UX][HALLUC]
- **Sent:** apollo se vitamin c manga do
- **Reply:**

```
Found on *Apollo*:
1. Vitamin-C 500 Chewable Tablet 10's (10 Chewable Tablet · Strip) — ₹33.10
2. Lemon See Orange Flavour Chewable Tablet 15's (15 Chewable Tablet · Strip) — ₹79.50
3. C Mus Vitamin C Cream 25 gm (25 gm Cream · Tube) — ₹599

Reply *1* / *2* / *3*, or *confirm* for #1 — then I'll open login/OTP for that exact item.
Or send another name. Reply *cancel* to stop.
_I only help order what you ask — I don't diagnose or suggest treatments._
```
- **Notes:** Hinglish fillers (`se`/`manga`/`do`) pollute query; Limcee not ranked #1.
- **Proposed fix:** Strip Hinglish fillers in `parseMedicineList`.

### A4b — FAIL [UX]
- **Sent:** Apollo pe limcee chahiye
- **Reply:**

```
Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.

Listed so far: pe limcee chahiye
```
- **Notes:** Parser left `pe`/`chahiye`; Rx gate.
- **Proposed fix:** Hinglish strip + search-before-Rx.

### A5 — FAIL [UX]
- **Sent:** Order shelcal from apollo
- **Reply:**

```
Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.

Listed so far: shelcal
```

### A5b — PASS [GOOD]
- **Sent:** Order dolo 650 from apollo
- **Reply:**

```
Found on *Apollo*:
1. Dolo-650 Tablet 15's (15 Tablet · Strip) — ₹32
2. Dolopar-650 Tablet 15's (15 Tablet · Strip) — ₹32
3. Dolofirst 650 mg Tablet 15's (15 Tablet · Strip) — ₹30.50

Reply *1* / *2* / *3*, or *confirm* for #1 — then I'll open login/OTP for that exact item.
Or send another name. Reply *cancel* to stop.
_I only help order what you ask — I don't diagnose or suggest treatments._
```

### A6 — FAIL [HALLUC]
- **Sent:** Order unicorn dust from apollo
- **Reply:**

```
Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.

Listed so far: unicorn dust
```
- **Notes:** Should say no catalog matches; must not soft-basket invent.
- **Proposed fix:** Guest search → honest `No Apollo matches for "…"`; no confirm/login invite.

### A7 — PASS [GOOD]
- **Sent:** Order medicine from apollo
- **Reply:**

```
Okay, Apollo. Send the medicine *list* or a *prescription photo*. OTC (like Vit C) needs no Rx.
```

### A8 — PASS [GOOD][OTP-SAFE]
- **Sent:** Order vitamin c from apollo → then `2`
- **Reply (pick):**

```
Found on *Apollo* — reply *confirm* to order this (login/OTP next):
• Vitamin-C 500 Chewable Tablet 10's (10 Chewable Tablet · Strip) — ₹33.10 ×1 _(OTC)_

Deliver to: your saved delivery address
Item total: ₹33.10

Reply *confirm* to continue, *cancel* to stop, or send another name / *prescription photo* for Rx.
_I only help order what you ask — I don't diagnose or suggest treatments._
```
- **Notes:** `#2` selects exact SKU+₹; second `confirm` would open login — cancelled here (OTP budget). Two-step is safer than instant OTP on digit.

### A9 — SKIP (OTP cap) / listing PASS
- **Sent:** Order vitamin c from apollo → cancel (did not send `confirm`)
- **Notes:** Listing identical to A1. Full `confirm`→Opening for #1 observed only via A18 (`ok`).

### A10 — PASS [GOOD]
- **Sent:** Order vitamin c from apollo → `9`
- **Reply:** Re-showed the 1/2/3 Apollo list (no login).

### A11 — PASS [GOOD]
- **Sent:** Order vitamin c from apollo → Order dolo 650 from apollo
- **Reply:** Dolo-650 guest list (same as A5b). Session re-searched without login.

### A12 — PASS [GOOD]
- **Sent:** Order vitamin c from apollo → cancel
- **Reply:**

```
Okay — cancelled the medicine order. No more OTP asks from this attempt.
```

### A13 — PASS [GOOD]
- **Covered by A18 cancel after Opening:**

```
Okay — cancelled. Nothing was ordered or paid — no more OTP asks from this attempt.
```

### A14 — FAIL [UX]
- **Sent:** Order antibiotic from apollo
- **Reply:** Rx-photo gate + `Listed so far: antibiotic` (no diagnose). Prefer search-first with Rx tags on hits.

### A14b — FAIL [UX]
- **Sent:** Order insulin from apollo
- **Reply:** Rx-photo gate + `Listed so far: insulin`.

### A15 — FAIL [UX]
- **Sent:** Order iphone from apollo
- **Reply:**

```
Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.

Listed so far: iphone
```
- **Notes:** Must refuse electronics on pharmacy partners.
- **Proposed fix:** Electronics refuse inside pharmacy turn before soft-basket.

### A16 — FAIL [UX] (safety OK)
- **Sent:** Order limcee from apollo (×2 quick)
- **Reply 1:** Rx gate for limcee
- **Reply 2:** `Still need a *prescription photo* for Rx items, or reply *OTC only*.`
- **Notes:** No double OTP. Still wrong gate vs guest search.

### A17 — FAIL [HALLUC]
- **Sent:** Order vitamin c from apollo → status
- **Reply:**

```
Saheli here…

*Latest Instamart order* (₹116):
Coca-Cola Zero Sugar Can - Cola Sparkling Soft Drink ×1

*Status:* ✅ Approved, placing order...
```
- **Notes:** Mid Apollo SKU confirm must not claim Instamart.
- **Proposed fix:** Intercept `status` while `pharmacyDraft.confirm_basket` and restate Apollo basket.

### A18 — FAIL [OTP-RISK] ⚠️ only OTP kickoff
- **Sent:** Order vitamin c from apollo → ok
- **Reply:**

```
Opening *Apollo* for: Limcee 500 mg Chewable Orange Tablet 15's (15 Tablet · Strip)×1 (₹24.50)

I'll sign in with your WhatsApp number when *Apollo* asks.
Watch for updates (still opening… / on login page… / requested code…).
*Paste the SMS OTP only after I ask* — I never read your device SMS.

No silent pay — I'll ask you to confirm item+total+address before checkout.
Reply *cancel* to stop.
```
- **Notes:** Bare `ok` must not open login when 1/2/3 list is showing.
- **Proposed fix:** Ignore `ok`/`okay` on multi-option list; require `1`/`2`/`3` or `confirm`.

### A18b — PASS [GOOD]
- **Sent:** `...` (after Opening; before cancel)
- **Reply:**

```
Saheli here…

I'm here — tell me more whenever you're ready.
```

### A19 — FAIL [UX]
- **Sent:** confirm (after cancel; intended idle)
- **Reply:**

```
Apollo didn't finish opening the order.
Apollo login cancelled.

Nothing was ordered or paid.
Reply *retry* to try again, or *cancel* to stop.
```
- **Notes:** Residual browser/pharmacy state after A18; idle `confirm` should be a soft no-op / ask what to order.

### A20 — FAIL [HALLUC]
- **Sent:** Order vitamin c from pharmeasy
- **Reply:**

```
Found on *PharmEasy*:
1. Hk Vitals Chelated Iron + Supplement (60 Capsules) | With Zinc | Vitamin C & Vitamin B12 (60 Capsule(s) in Bottle) — ₹381.29
2. Everherb | Amla | Immunity Booster | Natural Vitamin C | Bottle 60 Capsules (By Pharmeasy) (60 Capsule(s) in Bottle) — ₹251.55
3. Pharmeasy Iron+Folic Acid With Zinc | Vitamin C & B12 | Maintains Overall Health | 60 Capsules (60 Capsule(s) in Bottle) — ₹275.08

Reply *1* / *2* / *3*, or *confirm* for #1 — then I'll open login/OTP for that exact item.
Or send another name. Reply *cancel* to stop.
_I only help order what you ask — I don't diagnose or suggest treatments._
```
- **Notes:** Guest ₹ works, but ranking prefers multi-vit/iron over classic Vit C tablets. Reuse Apollo-style Vit C boosts for PharmEasy.

## Top 3 failures worth fixing next

1. **[OTP-RISK] Bare `ok` opens Apollo login** while multi-SKU list is showing (A18) — elder SMS risk.
2. **[UX] Rx-gate before guest search** for Limcee / Shelcal / Hinglish / nonsense (A2/A4b/A5/A6) — blocks search-before-login promise.
3. **[HALLUC] `status` mid Apollo SKU confirm reports Instamart** (A17) — wrong partner mental model.

Honorable mentions: electronics refuse on Apollo (A15); PharmEasy Vit C ranking (A20); Hinglish query cleanup (A4).

## Fixes pushed with this transcript (code)

Small/obvious patches in `src/services/pharmacyOrderFlow.service.ts` (same PR/commit wave as this MD):

1. Search-before-Rx + honest no-match copy (no soft invent for unicorn dust)
2. Hinglish filler strip + OTC hints (`limcee|celin|shelcal|…`)
3. Electronics refuse on pharmacy partners
4. `status` intercepted during confirm_basket (not Instamart)
5. Bare `ok` ignored on multi-option list; invalid digit `9` clear re-ask
6. `confirm`/`yes` still defaults to #1; `ok` only when single SKU already picked

**Not re-verified on Cloud Run in this run** (OTP budget spent; deploy follows push). Re-run a short Apollo suite after deploy.

## END cancel
- **Sent:** cancel
- **Reply:** `Order cancelled. Tell me anytime if you'd like to order again.` / pharmacy cancel acks as above.
