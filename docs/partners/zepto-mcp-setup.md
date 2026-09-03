# Zepto MCP — setup guide for Kavach

Kavach integrates with Zepto's **official MCP server** at `https://mcp.zepto.co.in/mcp`.

## What you need to do (one-time)

### Step 1 — Request redirect URI whitelist (required for production)

Zepto only allows OAuth from pre-approved redirect URLs.

1. Open: https://github.com/zeptonow/mcp/issues/new
2. Title: `Partnership: Whitelist Kavach redirect URI for caregiver ordering`
3. Body (copy/paste and adjust):

```
We're Kavach (https://app.kavach.care) — a caregiver dashboard for elderly families in India.

Saheli suggests grocery/pharmacy baskets; the primary caregiver approves in Kavach; we place orders via your MCP on the caregiver's linked Zepto account.

Please whitelist:
- Redirect URI: https://app.kavach.care/api/integrations/zepto/callback
- Domain: app.kavach.care
- Product: Kavach Care Dashboard
- Pilot: 1 family, Bangalore

For local dev (optional):
- http://localhost:3000/api/integrations/zepto/callback
```

4. Wait for Zepto to confirm (other apps like Botspot/Bimi did the same).

**Until whitelisted:** Connect button will fail at OAuth. Mock orders still work.

### Step 2 — Prepare the caregiver Zepto account

Use **Vish's** (or paying caregiver's) Zepto account:

1. Install Zepto app and sign in with Indian mobile number
2. Save **Sudha's delivery address** as default or saved address
3. Optional: add Zepto Cash or enable UPI for faster checkout

Orders run on the **connected caregiver's Zepto account**, not a shared Kavach account.

### Step 3 — Set environment variables

**Backend** (`kavach-backend/.env`):

```env
ZEPTO_MCP_URL=https://mcp.zepto.co.in/mcp
ZEPTO_MCP_REDIRECT_URI=https://app.kavach.care/api/integrations/zepto/callback
LIVE_FRONTEND_URL=https://app.kavach.care
```

**Local dev:**

```env
ZEPTO_MCP_REDIRECT_URI=http://localhost:3000/api/integrations/zepto/callback
LIVE_FRONTEND_URL=http://localhost:3000
```

(`AES_SECRET` must be set — OAuth tokens are encrypted at rest.)

**Dashboard** — no Zepto-specific vars; uses `NEXT_PUBLIC_API_URL` → backend.

### Step 4 — Connect in the dashboard

1. Sign in as primary caregiver (`vish2030@gmail.com`)
2. Go to **Integrations**
3. Click **Connect Zepto account**
4. Complete OTP on Zepto's page
5. You'll return to Integrations with "Connected"

### Step 5 — Test the order loop

1. **Approvals** — approve pending basket
2. Click **Pay** — with MCP connected, Kavach calls Zepto MCP to search, cart, and place order
3. If payment needs UPI, follow the link shown in Approvals / Care Record
4. Check **Billing** for order history

## How it works technically

| Step | Kavach | Zepto MCP |
|------|--------|-----------|
| Connect | OAuth PKCE → encrypted token in Cosmos | Phone OTP |
| Suggest | Search products for live prices (if connected) | `search_*` tools |
| Approve | Care Record event | — |
| Pay | `place_*` order via MCP | Real Zepto order |
| Write-back | `order_paid`, `order_delivered` events | Order status |

Fallback: if Zepto not connected, mock adapter + deep link (same as before).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `invalid_redirect_uri` | Whitelist not approved yet — file GitHub issue |
| Connect spins then error | Check backend logs; verify `AES_SECRET` |
| Pay succeeds but no delivery | UPI payment link may need manual completion in Zepto app |
| Wrong address | Update address in Zepto app for connected account |

## References

- Zepto MCP repo: https://github.com/zeptonow/mcp
- Order loop architecture: `docs/architecture/order-loop.md`
