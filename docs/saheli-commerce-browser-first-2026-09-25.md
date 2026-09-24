# Saheli commerce: browser-first for Swiggy / Zomato / Blinkit / Zepto / Instamart

**Date:** 2026-09-25 (IST)

## Why

MCP can search/connect for Instamart/Swiggy/Zepto but **cannot complete place reliably**. Elders order via WhatsApp with confirm-before-pay; the private Playwright browser (same path as pharmacy / any-site) is the primary fulfillment path for these five partners until MCP place is solid.

## Flag (keep MCP code)

| Env | Default | Effect |
|-----|---------|--------|
| `COMMERCE_BROWSER_FIRST` | **ON** (`1`) | Primary WA/AI path = private browser for listed partners |
| `COMMERCE_BROWSER_FIRST=0` | — | Restore MCP as primary for Swiggy/Instamart/Zepto |
| `COMMERCE_BROWSER_FIRST_PARTNERS` | `swiggy,zomato,blinkit,zepto,instamart` | Comma list to tweak |

MCP adapters, OAuth, and `partners/mcp/*` are **not deleted** — `getMcpCommerceAdapter` / MCP registry remain for flip-back.

Also still honors `BROWSER_WORKER_MODE=auto|playwright|dry_run` for live vs dry-run.

## Routing

1. WA `messageLooksLikeBrowserTask` / `siteResolve` → browser for the five when flag on  
2. `resolveElderCommercePath` → `browser` / automation session (skips MCP)  
3. `getCommerceAdapter` → browser adapter when flag on; MCP adapter when flag off  
4. AI `browser_order` preferred; `quick_order` auto-routes browser-first partners to browser  

Pharmacy / rides kill-switches unchanged (`BROWSER_PHARMACY_LOGIN`, ride defaults).

## Smoke

```bash
cd kavach-backend
BROWSER_WORKER_MODE=dry_run COMMERCE_BROWSER_FIRST=1 npx tsx scripts/smoke-private-browser.ts
```

Manual WA: `order milk from instamart` / `zepto` / `blinkit` or `order pizza from swiggy` / `zomato` → OTP ask → confirm item+total+address → no forever typing.

## Residual risks

- Bot walls / CAPTCHA on partner sites → clear WA error, retry later  
- OTP paste timing (parked page) — same patterns as pharmacy  
- Live Chromium required on Cloud Run (`BROWSER_WORKER_MODE=auto`)

## Search-before-login (2026-09-25)

Browser-first still places via Playwright, but WA now **guest/MCP-searches first** and asks confirm of exact SKU+₹ before opening login/OTP. See `saheli-commerce-search-before-login-2026-09-25.md`.
