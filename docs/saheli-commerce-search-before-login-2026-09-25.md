# Saheli commerce: search-before-login (confirm SKU + price first)

**Date:** 2026-09-25 (IST)

## Why

Previously `Order vitamin c from apollo` built a soft basket (`vitamin c capsules ×1`) with no live price, and *confirm* opened the private browser + login/OTP immediately. Elders never saw the exact SKU or ₹ before SMS.

## Rule (all order partners)

1. **Search first** — guest/public catalog or connected MCP search. **No login / no OTP / no Continue.**
2. **WhatsApp exact product + price** (and qty). Offer 1–3 options when useful.
3. **Only after confirm** (or `1`/`2`/`3`) → open login / OTP / place for that exact SKU.
4. **Honest WA** — never invent a product name or ₹. If guest prices are unavailable, say so and still require confirm before opening the site.

## Sources

| Partner | Guest search |
|---------|----------------|
| Apollo | Public `accessToken` + `search-service/v5/fullSearch` |
| PharmEasy | Public `/api/search/search` |
| Tata 1mg | No stable guest price API — honest copy; confirm opens browser |
| Instamart / Swiggy / Zepto | MCP search when connected (no new SMS); else honest + confirm opens browser |
| Blinkit / Zomato | No stable guest price API (public catalog blocked) — honest + confirm opens browser |
| Others (BigBasket / Amazon / …) | Not wired for guest yet — honest + confirm opens browser |

Code: `src/services/commerceAutomation/guestCatalogSearch.service.ts`  
Pharmacy WA: `pharmacyOrderFlow.service.ts` (`attachGuestCatalog` before `confirm_basket`)  
Grocery/browser-first WA: `browserTaskWhatsApp.service.ts` (`awaiting_sku_confirm` phase)

## Example WA copy (Apollo)

```
Found on *Apollo*:
1. Limcee 500 mg Chewable Orange Tablet 15's (15 Tablet · Strip) — ₹24.5
2. Vitamin-C 500 Chewable Tablet 10's (10 Chewable Tablet · Strip) — ₹33.1
3. …

Reply *1* / *2* / *3*, or *confirm* for #1 — then I'll open login/OTP for that exact item.
Or send another name. Reply *cancel* to stop.
```

## Unchanged

- Confirm-before-pay at checkout
- `COMMERCE_BROWSER_FIRST` for grocery/food place path
- MCP adapters kept for flip-back / connected search
- Pharmacy OTP one-shot + cancel silence
