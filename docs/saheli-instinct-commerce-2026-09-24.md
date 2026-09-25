# Saheli Instinct-parity commerce — 2026-09-24

## Behavior change (Phase D — shipped)

**Elders (CARE_RECIPIENT) place grocery/pharmacy orders from their own WhatsApp number without caregiver approval.**

| Before | After |
|--------|--------|
| Default `allowRecipientDirectOrders: false` → elder carts parked in `awaiting_approval` | Default **true**; CARE_RECIPIENT **never** gated by `orderRequiresCaregiverApproval` |
| Caregiver had to Approve & place | Elder completes checkout on their session; caregivers get **notify-only** |
| Approvals page only showed pending baskets | Recent **placed · notified** section for elder orders |

### How an elder orders

1. Elder messages Saheli on WhatsApp (e.g. “Order diet coke from instamart”).
2. Saheli searches / builds cart on the **elder’s own partner session** when connected (`resolveFamilyMcpUserId` prefers the actor). Falls back to a family-connected caregiver MCP account only if the elder has none.
3. Elder confirms basket (and address/total). Checkout auto-approves + pays as the elder (self-checkout permission — no `approve_order` role required).
4. Order status → `paid` (or partner error surfaced honestly). **Never** `awaiting_approval` for CARE_RECIPIENT groceries.
5. Caregivers receive WhatsApp + in-app: *“Amma placed an order on Instamart — ₹… (items). Notify only — no approval needed.”*

### Caregiver-initiated orders

Unchanged: caregivers with `approve_order` still place directly. Care-record logging of orders is preserved.

### Settings UI

Integrations → partner → **Elder ordering**: default “Elder can order · caregivers notified”. Toggle kept for legacy; WhatsApp elder path ignores approval gates per product rule.

---

## Pharmacy partners (Phase C scaffold — honesty)

Instinct also orders **medicines** via WhatsApp. Kavach path:

| Partner | Status |
|---------|--------|
| Apollo Pharmacy | **Scaffold** — adapter + WA partner pick; no live API yet |
| PharmEasy | **Scaffold** |
| Tata 1mg | **Scaffold** |
| OTC text list (e.g. Vit C) | WA flow asks partner + confirms total/address before pay |
| Rx-required | Reuses existing Rx photo vision (`whatsappMediaIngest` / `saheliMediaVision`); ask photo before pay; never diagnose |

Pharmacy orders follow the same product rules: elder places, caregivers **notify-only**.

---

## Phase A / B / C (this wave)

- **Phase A (partial):** small-cart fee narration, substitution tips on catalog miss, clearer Connect CTA + elder OTP copy, ETA/track lines when bill has them.
- **Phase B (partial):** WA OTP relay + OAuth URL connect attributed to elder user id via `commerceAutomation` session store; full Swiggy OAuth submit still partner-dependent.
- **Phase C (foundation):** `commerceAutomation/` adapters + encrypted session store + `resolveElderCommercePath` (MCP → automation session → start login). Playwright Instamart login+search **not** live yet.
- **Pharmacy:** WA conversational path for Apollo / PharmEasy / Tata 1mg (list or Rx photo, confirm total+address, notify-only). **Place is scaffold** — no live pharmacy API.

## Remaining gaps

- **Phase A remaining:** stronger fee narration, substitution prompts, Instamart connect deep link, ETA after place.
- **Phase B**: conversational partner OTP/OAuth attributed to elder user id.
- **Phase C**: `commerceAutomation/` session store + OTP state machine; Playwright Instamart login+search when automatable; pharmacy adapters beyond scaffold.
- Full pharmacy place/pay is **not** live until partner automation or official APIs land.

## Smoke expectation

Mock webhook as `<test-elder-number>`: “Order diet coke from instamart” → must **not** say needs caregiver approval; proceed to connect/OTP/search/cart.
