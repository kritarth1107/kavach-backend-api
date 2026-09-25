# Saheli any-site commerce + health-aware tips — 2026-09-24

Extends private browser (SHA ~cb91693 Chromium / Gemini planner) so Saheli can **order from any website**, not only Instamart/Swiggy/Zepto/Apollo, with **soft health / care suggestions** before confirm (Kavach explainer video: Saheli suggests, elder decides).

## Product rules (shipped)

| Rule | Behavior |
|------|----------|
| Any-site order | “order X from amazon/flipkart/myntra/bigbasket/…” or paste HTTPS product URL → private browser profile searches/carts |
| Confirm before pay | Item + total + address card; OTP paste in WA when needed; **no silent pay** |
| Health-aware tips | Before confirm, inject soft tips from care record / meds / conditions when relevant (salt+BP, juice+Metformin, OTC soft tips). Never diagnose; never block |
| Grocery expansion | BigBasket, JioMart, DMart Ready, Nature’s Basket, Blinkit + **generic grocery** fallback |
| Non-grocery | Amazon.in, Flipkart, Myntra + **generic any HTTPS shop** (URL or Google site search) |
| MCP vs browser | Keep MCP for Instamart/Swiggy/Zepto when connected; browser when MCP missing **or** user names another site / any site / URL |
| Elder notify | Caregivers notify-only on place (unchanged). Caregiver self-order = personal PA |
| Model | Stay on Gemini browser planner — no stack change |

## Supported sites (browser playbooks)

- **Grocery:** BigBasket, JioMart, DMart Ready, Nature’s Basket, Blinkit; Instamart/Zepto/Swiggy as browser fallback; generic grocery when domain unknown
- **Pharmacy:** Apollo, PharmEasy, Tata 1mg
- **Retail:** Amazon.in, Flipkart, Myntra
- **Generic:** any HTTPS product URL or unknown “from &lt;shop&gt;” → Google site search → planner navigates

MCP path unchanged for connected Instamart / Swiggy Food / Zepto.

## Soft limits

- **Generic / hard sites** may fail CAPTCHA, app-only checkout, or heavy anti-bot — confirm+OTP UX still works; live cart is best-effort via Gemini+Chromium.
- Health tips need care-record / memory hits; without context the confirm card still works (tips omitted).
- No silent pay; UPI may still need the user to tap in-app.

## Health-hint wiring

- Builder: `saheliCommerceHealthHints.service.ts` → `buildCommerceHealthSuggestions` / `formatCommerceHealthSuggestionsForCopy`
- Attached on browser `need_user_confirm` (dry-run + Playwright) via `attachHealthHints` in `browserWorker.service.ts`
- Also returned on MCP `quick_order` / order orchestrator (existing)
- Tips: diet (BP+salt), medication (Metformin+sweet), OTC soft tips, memory preference snippets

## Tools / prompts

- Backend tools: `browser_order`, `browse_and_shop` (alias)
- AI engine: elder + caregiver StructuredTools; order playbook prefers MCP then browser_order
- Router: `messageLooksLikeBrowserTask` / `siteResolve.ts` domain detection

## Files

- `src/services/commerceAutomation/siteResolve.ts` (new)
- `src/services/commerceAutomation/playbooks.ts`
- `src/services/commerceAutomation/browserTaskWhatsApp.service.ts`
- `src/services/commerceAutomation/browserWorker.service.ts`
- `src/services/commerceAutomation/types.ts` / `adapters.ts`
- `src/services/saheliCommerceHealthHints.service.ts`
- `src/services/saheliTools.service.ts` (`browser_order`)
- `src/services/saheliElderPipeline.service.ts` (browser before unsupported)
- `docs/saheli-private-browser-2026-09-24.md` (cross-link)

## Smoke

```bash
BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-private-browser.ts
```

Expect: `order oats from bigbasket` and `buy this from amazon` → browser confirm flow (not “unsupported”); confirm card includes soft *Saheli tip* when stubbed/care context present.

Mock WA `<test-elder-number>`: same phrases on live backend after deploy.

## Hang fix (pharmacy confirm follow-up)

After *confirm* on Apollo/PharmEasy/1mg, WhatsApp always gets a second message within ~1 min
(progress / OTP tip / CAPTCHA / soft failure). See `saheli-private-browser-2026-09-24.md`
§ “Pharmacy confirm → no forever silence”. Reply *retry* to re-kick the browser, *cancel* to stop.

