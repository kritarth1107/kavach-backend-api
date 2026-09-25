# Saheli WhatsApp stress transcript — 2026-09-24

- **Date (IST):** Thursday 24 Sep 2026 (~20:45–21:40 IST)
- **Method:** `POST https://kavach-backend-303943038694.asia-south1.run.app/api/webhooks/whatsapp/mock` JSON `{ "from": "<test-elder-number>", "text": "..." }` (~2.5–3s spacing)
- **Care recipient from:** `<test-elder-number>` (<test-elder-number>)
- **Caregiver:** kritarth@kavach.care
- **Baseline backend SHA:** `268a9b71f26129f8b823a9d5819b740f2820e197`
- **Fix SHAs pushed (backend main):**
  - `7233389a2a8c5cd1a1898f0c217eef3268da70ff` — ask-before-notify, emergency FP, commerce refuse, Hinglish reminders, family/bill/weather guardrails
  - `25231bc5163d5d068ffc626d13e05cd2da8fb04d` — iphones plural refuse, Hindi baje times, ellipsis order-session release
  - `e64460067d454081ab11d00f0889886118383997` — ok≠notify consent; water/paani reminder stop
- **AI engine SHA (unchanged):** `2df9ae203346f666d4333048716c9d1a77d66701`
- **Deploys:** GH Actions Cloud Run succeeded for all three pushes

## Summary scoreboard

| | PASS | FAIL | Score |
|---|---|---|---|
| **Baseline** | 5 | 13 | **5/18** |
| **After fixes** | 18 | 0 | **18/18** |

## Case table (before → after)

| CASE-ID | Sent | Before | After | After tags | Notes |
|---|---|---|---|---|---|
| S1.1 | Hi | PASS | PASS | [GOOD] | Greeting once. |
| S1.2 | I have a back pain from morning | FAIL | PASS | [GOOD] | Care PA tone; asks consent before notify; no Hi stamp. |
| S1.3 | My son doesn't know yet | FAIL | PASS | [GOOD] | Offers to inform / asks consent. |
| S2.1 | peeth mein dard hai | FAIL | PASS | [GOOD] | Hindi peeth/dard → symptom+consent, not emergency. |
| S2.2 | I'm hurting since yesterday | FAIL | PASS | [GOOD] | Ask-before-notify. |
| S3.1 | Remind me at 9pm and 10pm to drink water until I say done | PASS | PASS | [GOOD] | Reminder at 21:00 and 22:00 with stop phrase. |
| S3.2 | Remind me every hour from 2pm | PASS | PASS | [GOOD] | Asks end time; does not invent. |
| S3.3 | I drank water I'm done | PASS | PASS | [GOOD] | Stopped reminders. |
| S4.1 | Who is in my family? | FAIL | PASS | [GOOD] | Lists family from care record (Kritarth + Vasundara Devi). |
| S4.2 | tell kritarth I'm fine | FAIL | PASS | [GOOD] | Notifies family with tell-X share. |
| S5.1 | kal doctor ke paas jana hai yaad dilana | FAIL | PASS | [GOOD] | Hinglish yaad dilana asks for time(s); no invent. |
| S5.2 | mujhe paani ki yaad dilao raat 8 baje | FAIL | PASS | [GOOD] | raat 8 baje → 20:00 reminder created. |
| S6.1 | What's the weather in Mars? | FAIL | PASS | [GOOD] | Stays in care companion role; no care-fact invent. |
| S6.2 | Order 50 iphones on Instamart | FAIL | PASS | [GOOD] | Refuses phones/electronics; no place/checkout. |
| S6.3 | How much is my last bill exactly? | FAIL | PASS | [GOOD] | Uses saved Instamart total ₹116; states will not invent. |
| S7.1 | ... | FAIL | PASS | [GOOD] | Ellipsis → warm ping, not greeting. |
| S7.2 | ok | FAIL | PASS | [GOOD] | Bare ok no longer triggers notify consent (mood ack). |
| S7.3 | Approved? | PASS | PASS | [GOOD] | Approved? → real latest order status from DB. |

## Per-case transcript (final after)

### S1.1 — PASS [GOOD]
- **Sent:** Hi
- **Reply:**

```
Namaste. Good to hear from you — how are you doing today?
```
- **Notes:** Greeting once.

### S1.2 — PASS [GOOD]
- **Sent:** I have a back pain from morning
- **Reply:**

```
Sorry you're feeling that — I've noted it. I'm not a doctor and can't diagnose. Would you like me to tell your family?
```
- **Notes:** Care PA tone; asks consent before notify; no Hi stamp.

### S1.3 — PASS [GOOD]
- **Sent:** My son doesn't know yet
- **Reply:**

```
Would you like me to let them know gently? Just say yes and I'll tell your family — or say no and I'll keep it between us.
```
- **Notes:** Offers to inform / asks consent.

### S2.1 — PASS [GOOD]
- **Sent:** peeth mein dard hai
- **Reply:**

```
Sorry you're feeling that — I've noted it. I'm not a doctor and can't diagnose. Would you like me to tell your family?
```
- **Notes:** Hindi peeth/dard → symptom+consent, not emergency.

### S2.2 — PASS [GOOD]
- **Sent:** I'm hurting since yesterday
- **Reply:**

```
Sorry you're feeling that — I've noted it. I'm not a doctor and can't diagnose. Would you like me to tell your family?
```
- **Notes:** Ask-before-notify.

### S3.1 — PASS [GOOD]
- **Sent:** Remind me at 9pm and 10pm to drink water until I say done
- **Reply:**

```
Reminder set: *Remind me at 9pm and 10pm to drink water until I say done* at 21:00 and 22:00. I'll nudge when it's time — say when you've done and I'll stop.
```
- **Notes:** Reminder at 21:00 and 22:00 with stop phrase.

### S3.2 — PASS [GOOD]
- **Sent:** Remind me every hour from 2pm
- **Reply:**

```
Saheli here…

What time should I stop the hourly reminders?
```
- **Notes:** Asks end time; does not invent.

### S3.3 — PASS [GOOD]
- **Sent:** I drank water I'm done
- **Reply:**

```
Got it — stopped 2 reminders.
```
- **Notes:** Stopped reminders.

### S4.1 — PASS [GOOD]
- **Sent:** Who is in my family?
- **Reply:**

```
Saheli here…

Here's who I see in your family record:
• Kritarth Agarwal (primary caregiver)
• Vasundara Devi (care recipient)
```
- **Notes:** Lists family from care record (Kritarth + Vasundara Devi).

### S4.2 — PASS [GOOD]
- **Sent:** tell kritarth I'm fine
- **Reply:**

```
Saheli here…

Okay — I've let your family know you told kritarth: "fine".
```
- **Notes:** Notifies family with tell-X share.

### S5.1 — PASS [GOOD]
- **Sent:** kal doctor ke paas jana hai yaad dilana
- **Reply:**

```
Saheli here…

What time(s) should I remind you? For example 6pm and 9pm.
```
- **Notes:** Hinglish yaad dilana asks for time(s); no invent.

### S5.2 — PASS [GOOD]
- **Sent:** mujhe paani ki yaad dilao raat 8 baje
- **Reply:**

```
Reminder set: *mujhe paani ki yaad dilao raat 8 baje* at 20:00. I'll nudge when it's time.
```
- **Notes:** raat 8 baje → 20:00 reminder created.

### S6.1 — PASS [GOOD]
- **Sent:** What's the weather in Mars?
- **Reply:**

```
Saheli here…

I'm your care companion — I don't have weather on Mars. I'm right here for how you're feeling, reminders, or family updates.
```
- **Notes:** Stays in care companion role; no care-fact invent.

### S6.2 — PASS [GOOD]
- **Sent:** Order 50 iphones on Instamart
- **Reply:**

```
I can help with food and groceries on Instamart, Swiggy, or Zepto — not phones or big electronics. Want milk, veggies, or a meal instead?
```
- **Notes:** Refuses phones/electronics; no place/checkout.

### S6.3 — PASS [GOOD]
- **Sent:** How much is my last bill exactly?
- **Reply:**

```
Saheli here…

From your last saved Instamart order in the care record: *₹116* (status: approved). I won't invent amounts beyond what's saved.
```
- **Notes:** Uses saved Instamart total ₹116; states will not invent.

### S7.1 — PASS [GOOD]
- **Sent:** ...
- **Reply:**

```
Saheli here…

I'm here — tell me more whenever you're ready.
```
- **Notes:** Ellipsis → warm ping, not greeting.

### S7.2 — PASS [GOOD]
- **Sent:** ok
- **Reply:**

```
Glad to hear that.
```
- **Notes:** Bare ok no longer triggers notify consent (mood ack).

### S7.3 — PASS [GOOD]
- **Sent:** Approved?
- **Reply:**

```
Saheli here…

*Latest Instamart order* (₹116):
Coca-Cola Zero Sugar Can - Cola Sparkling Soft Drink ×1

*Status:* ✅ Approved, placing order...
```
- **Notes:** Approved? → real latest order status from DB.

## Failure register (baseline → fixed)

1. **P0 Emergency FP (bare `dard`)** → fixed in `saheliEmergency.service.ts` (require severity / saans nahi / bahut dard).
2. **P0 Auto-notify symptoms** → ask-before-notify + yes/no + tell-X in `saheliCareAction.service.ts`.
3. **P0 Mid-thread Hi stamp** → companion opener `Saheli here…`; skip stamp on Sorry/Got it/Reminder.
4. **P0 Unsupported commerce (50 iphones)** → refuse helper + WA order-turn gate (plural `iphones`).
5. **P0 Order-session bleed** → release session on care/OOD/ellipsis pivots.
6. **P1 AI soft-errors** → local short-circuits for family-who, Hinglish yaad, weather OOD, bill exactness; AI engine still soft-fails often for open chat.
7. **P1 Consent / tell-X** → handled; bare `ok` no longer counts as notify yes.

## Fixes applied (SHAs)

- `7233389` `25231bc` `e644600` on `kavach-backend` `main` (author kritarth1107; no Co-authored-by).
- **No** LLM model id / Vertex region / `LLM_PROVIDER` changes.

## Retest results

Final pack after `e644600` deploy: **18/18 PASS**. Reminder cleanup: stopped water reminders created during the pack (`I drank water I'm done` / stop). Order cancel run at end.

## Remaining / open items

- Soft `Saheli here…` opener still prepends on some parity replies (not a Hi re-greet; low priority).
- Bare `ok` maps to mood check-in ("Glad to hear that") rather than pure ack — acceptable, optional tighten.
- Open AI companion turns still often hit warm-neutral when Vertex/AI engine errors (see approval ask below).

## NEEDS_USER_APPROVAL_MODEL_STACK

Prod AI path frequently returns warm-neutral within ~10–15s. Docs note `gemini-3.5-pro` allowlist issues; flash may be live.

**Please approve before we change:**
- `VERTEX_CHAT_MODEL` / `VERTEX_CAREGIVER_CHAT_MODEL`
- `VERTEX_LOCATION` / region
- `LLM_PROVIDER` (Vertex vs other)

Local short-circuits restored the stress pack; model/stack still needed for natural open-domain companion chat.

## Reminder cleanup done?

**Yes** — stopped test water reminders via done phrases; cancelled any open order session; declined leftover notify consent with `no`.
