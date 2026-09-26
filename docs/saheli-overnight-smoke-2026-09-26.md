# Saheli — Gemini router + privacy smoke tests (26 Sep 2026)

All turns went through the deployed **secret-gated mock webhook** (`/api/webhooks/whatsapp/mock`), exactly as a WhatsApp inbound would. None of these turns pressed *confirm*, entered an OTP, or placed an order.

**Test families:** three synthetic families were created by the secret-gated `/mock/smoke-fixtures` endpoint. They use `+999…` numbers (an unassigned ITU code). `whatsappRecipientGuard` refuses every Meta send to them, so no real person got a message.

| Phone | Family | Saved address |
|---|---|---|
| +999100000001 | Smoke A | Flat 12, Lake View Apartments, Shyamla Hills, Bhopal 462002 |
| +999100000002 | Smoke B | H-5, Connaught Place, New Delhi 110001 |
| +999100000003 | Smoke C | none (Saheli has to ask) |

**Router:** `saheliRouter.service.ts` uses Gemini Flash (`vertexFlashModel()`) with structured output (`responseSchema`) at a low thinking level. After that change, observed latency was **1.1–1.4 s** per turn. Before it, latency was 1.5–3.3 s, and one turn timed out (see F6).

## Results

| # | Family | Message | Router (intent / slots) | Reply (short) | Result |
|---|---|---|---|---|---|
| 1 | A | Can u order me a rite bite protein bar | order_new · grocery · q="rite bite protein bar" · no platform | "Comparing *Instamart* and *Blinkit* … near 📍 Bhopal 462002" plus an honest Zepto note | ✅ routing (see F1 for the sites) |
| 2 | A | I want to order amul butter from zepto | order_new · partners=[zepto] | "Zepto blocks automated browsing…" then compares Instamart + Blinkit (note shown once) | ✅ |
| 3 | A | Instamart (bare reply) | order_modify · partnerOnly · instamart | "Searching *Instamart* for "amul butter"…" (product taken from context) | ✅ |
| 4 | A | paracetamol chahiye | order_new · pharmacy · q=paracetamol | Apollo + PharmEasy price list (Dolo/Crocin, ₹12.78–₹32, platform per line) | ✅ |
| 5 | A | doosra wala | order_control · pick · 2 | "Found on *PharmEasy*: Dolo 650 — ₹29.05, 📍 Bhopal" | ✅ |
| 6 | A | will it come to my home? | order_modify · addressKind=same | "Yes 🙂 … your saved address: 📍 Bhopal…" | ✅ |
| 7 | A | what's happening with my order? | order_control · status | current card restated | ✅ |
| 8 | A | by the way, did I take my morning medicine? | reminder_or_meds | AI engine error was **leaked** ("get_missed_tasks() got an unexpected keyword argument 'title'") | ❌ → fixed (F2) |
| 9 | A | rehne do, nahi chahiye | order_control · cancel | "Okay, cancelled ✅ Nothing was ordered or paid." | ✅ |
| 10 | A | speak to me in English from now on | language_change · en | first run **crashed the service** (503) | ❌ → fixed (F3). Re-run: "Got it — I'll talk to you in English" ✅ |
| 11 | A | bolo hindi mein | language_change · hi | "…in Hindi from now on." | ✅ (after F3) |
| 12 | A | can you talk in bengali? | language_change · bengali | "I can talk in English, Hindi, Hinglish, Tamil or Kannada…" | ✅ |
| 13 | A | mujhe station jaana hai, cab book kar do → "ghar se" | ride · rideDrop=station → ridePickup=home | first run: "Pickup noted: *mujhe station jaana hai*", then the station geocoded to Helsinki | ❌ → fixed (F4). Now: "Drop noted: Sant Hirdaram Nagar Railway Station" → "from Flat 12 … Bhopal 462002 to …Railway Station — reply yes" ✅ |
| 14 | A | book an auto from DB Mall to AIIMS Bhopal | ride | "from DB Mall, Racecourse Road to AIIMS…" then "Reply yes…" | ✅ |
| 15 | A | rehne do (during ride) | order_control · cancel | "cancelled. Nothing was booked or paid." | ✅ |
| 16 | A | Hi Saheli, can you order some food for me? I feel like eating paneer | order_new · food · q=paneer | Swiggy restaurants search for "paneer" | ✅ routing (Swiggy couldn't set the fictional Bhopal address, see F1) |
| 17 | B | are you there? / sun rahi ho saheli? | presence_check | warm presence reply | ✅ |
| 18 | B | aaj mausam bahut accha hai, purane din yaad aa gaye | companion_chat | companion reply | ✅ |
| 19 | B | where will my orders be delivered? | first run: account_info → "No recent orders found" | ❌ → prompt fixed. Re-run: "📍 H-5, Connaught Place…" ✅ |
| 20 | B | remind me to take my BP tablet at 9 pm every day | reminder_or_meds | "Reminder set … at 21:00" | ✅ |
| 21 | B | please tell my son that I am fine today | caregiver_share | "I've let your family know…" | ✅ (copy is clunky, not changed) |
| 22 | B | mere ghutno mein bahut dard hai | (keyword safety net fired before the router) | emergency reply + family alerted | ✅ as designed; the keyword net is sensitive (knee pain escalates) |
| 23 | B | khana order karna hai, kaunse restaurant khule hain? | restaurant_list · food | 5 open Swiggy restaurants near Connaught Place | ✅ |
| 24 | B | pehla wala | order_control · pick 1 | Bakingo menu (5 dishes with prices) | ✅ |
| 25 | B | vitamin c tablets chahiye | order_new · pharmacy | Apollo + PharmEasy (Limcee ₹24.50 / ₹24.09, Celin ₹41…) | ✅ |
| 26 | B | aaj kya khana banau? kuch halka sa batao (options still open) | companion_chat | khichdi / dalia suggestion; order left untouched | ✅ |
| 27 | B | 3rd one please | pick 3 | "Found on *Apollo*: Celin 500 — ₹41, 📍 Connaught Place" | ✅ |
| 28 | B | haan le li dawai subah wali | reminder_or_meds | warm acknowledgement | ✅ |
| 29 | B | 4821 / 123456 (nothing waiting for a code) | otp_code | first run: "Sorry — No order found" | ❌ → fixed (F5). Now chat ✅ |
| 30 | C | mujhe atta mangwana hai | order_new · grocery | asks for the address (nothing saved) | ✅ |
| 31 | C | mujhe dolo 650 chahiye, then "apollo se" (waiting for address) | order_modify · partner | "Got it 👍 I'll look for "dolo 650" on *Apollo* as soon as I have your delivery address" | ✅ |
| 32 | C | Flat 7, Rose Residency, Koregaon Park, Pune 411001 | address | first run: saved, then "What would you like to order?" (didn't resume) | ❌ → fixed. Now: saved **and** Apollo Dolo list shown ✅ |
| 33 | C | mujhe crocin chahiye apollo se, then "dusra wala" | pick 2 | Crocin Advance ₹19, 📍 Pune | ✅ (a router timeout once sent "dusra wala" to the old regex, see F6) |

**Cross-family isolation:** every reply showed only that family's own address (A Bhopal, B Delhi, C Pune). None showed another family's address, and none showed the owner's address. Route memory, turn memory and debug data are keyed per phone.

## Findings and fixes (all deployed)

- **F1 – Grocery sites from Cloud Run.**
  - Swiggy restaurants work.
  - Apollo and PharmEasy work (public APIs).
  - From Cloud Run's datacenter IPs:
    - **Instamart** returns "Something went wrong" on the search page.
    - **Blinkit** served "access denied" once, then a page with no location box.
  - Both work from a normal connection (checked locally: RiteBite at ₹79–₹88).
  - Replies now say this honestly ("…blocking my browser right now"). Stack traces are never shown.
  - A real fix needs a residential egress or the partner APIs.
- **F2 – AI engine schedule tools crashed on a `title` argument.**
  - `get_today_schedule` and `get_missed_tasks` now accept every `ScheduleTitleArgs` field.
  - Internal errors are never shown to families (ai-engine fb1b9a0).
- **F3 – Elder language change threw a 403.**
  - `updateCompanionProfile` is caregiver-only. On the mock path the unhandled rejection **crashed the whole service**.
  - Added a self-service `setOwnPreferredLanguage`, a try/catch in the mock controller, and a process `unhandledRejection` guard.
- **F4 – Ride places.**
  - The router now extracts `ridePickup` / `rideDrop`.
  - Places resolve near the elder's own saved city, and "home"/"ghar" means their saved address. Before this, "station" geocoded to Helsinki.
- **F5 – Stray digits.** With nothing waiting for a code, digits are just chat and never trigger an order lookup.
- **F6 – Router latency.**
  - Structured output plus thinking tokens could exceed the 6 s budget.
  - Now: low thinking level (dropped automatically if a model rejects it), a 7 s budget, and one quick retry.
  - The regex fallback also maps spoken ordinals ("dusra wala" → 2).

| 34 | Owner tester number | My delivery address is <owner address with pincode> | order_modify · address | first run: model read it as "same" → "no address saved" | ❌ → fixed. Now "Saved your delivery address ✅" ✅ (saved to the owner's family only) |
| 35 | Owner | where will my orders go? | addressKind=same | owner's own saved address | ✅. Immediately after, B still got Connaught Place ✅ |
| 36 | Owner | did I take my morning medicine? | reminder_or_meds | "your morning BP medicine (8:00 AM) is still showing as missed…" | ✅ (F2 confirmed on a real schedule) |

**Privacy audit re-run** (after the owner-family detection fix):
- owner family = b40f…e3b;
- address rows in any other family: only the 1 ActivityLog row from before the fix (ac39…ded);
- open drafts in other families: 0.

The synthetic families were deleted after the run.

## Regex routers: replaced vs kept

When the router returns a route, every gate below is skipped. Its regex runs **only** when Gemini is unavailable (router returns null).

**Replaced by the Gemini router:**
1. `parseLanguageChangeMessage` as the trigger. It now only maps the model's `newLanguage` onto a supported code.
2. `messageIsPresenceCheck`.
3. The early mid-flow short-control regex (`status|ok|confirm|[1-9]|cancel|order again…`) for pharmacy and browser drafts.
4. The `tryHandleWhatsAppDashboardAction` intent regexes (reminders, DND, approvals, order status, family brief, labs, schedule, bills, partner connect). They now run only when the model says reminder_or_meds, caregiver_share, account_info or order_status_history, and work as a slot executor.
5. `messageLooksLikeRideIntent`, the bare "yes/ok" ride start, and ride slot text. The model now supplies `ridePickup`/`rideDrop`.
6. `messageLooksLikePharmacyOrder` (Vit C / medicine intent).
7. `messageLooksLikeBrowserTask`, `ORDER_VIA_BROWSER_LEGACY`, `wantsRestaurantList`, and the `partnerFromText` partner switch.
8. Mid-order `classifyOrderInterrupt` (rules + LLM), `classifyAddressMention` and `isAddressOnlyMessage`. These are skipped for routed turns.
9. `extractOrderQuery` / `extractFoodQuery` product extraction. Replaced by the `productQuery` slot.
10. OTP *detection* by `/^\d{4,8}$/`. The model detects the code; the regex now only validates it.
11. `tryHandleWhatsAppOrderTurn` (app order-session regex) and `tryHandleCaregiverWhatsAppOrderCommand`. They run only on fallback, or when a commerce intent had no executor.
12. Hindi/English ordinals: the model sets `pickIndex`. The fallback maps "dusra wala" → 2.

**Kept on purpose:**
- **Emergency keyword net** (`messageLooksLikeEmergency`). Always runs first and is never removed. The async Gemini red-flag screen still runs too, and a router `emergency` (confidence ≥ 0.75) escalates as an extra layer.
- **Strict OTP check** `/^\d{4,8}$/`, applied after the model says it's a code.
- **Money guardrail:** a real order (awaiting_confirm) needs the literal word *confirm*. "yes/ok/haan" get "reply *confirm*…". The model can't map "ok" to placing an order.
- **Address validation** `parseAddressReply` (6-digit pincode and ≥8 letters), plus cancel inside the address step.
- **Policy lists:** site allowlist, `ELECTRONICS_REFUSE`, and Rx filtering.
- **Structured ids:** interactive button ids (`quick_confirm:` / `quick_change_addr:`), the media placeholder, and caregiver recipient pick by number.
- **Fallback:** all the regex gates above, used only when the model call fails or times out.
