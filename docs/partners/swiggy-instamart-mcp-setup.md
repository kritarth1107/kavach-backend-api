# Swiggy & Instamart MCP setup

Kavach uses the official Swiggy MCP servers for food and grocery ordering.

| Partner | MCP endpoint | OAuth callback (production) |
|---------|--------------|----------------------------|
| Swiggy Food | `https://mcp.swiggy.com/food` | `https://app.kavach.care/api/integrations/swiggy/callback` |
| Instamart | `https://mcp.swiggy.com/im` | `https://app.kavach.care/api/integrations/instamart/callback` |

Docs: [Swiggy MCP overview](https://mcp.swiggy.com/builders/docs/start/what-is-swiggy-mcp.md)

## Backend env vars

```env
SWIGGY_MCP_URL=https://mcp.swiggy.com/food
SWIGGY_MCP_REDIRECT_URI=https://app.kavach.care/api/integrations/swiggy/callback

INSTAMART_MCP_URL=https://mcp.swiggy.com/im
INSTAMART_MCP_REDIRECT_URI=https://app.kavach.care/api/integrations/instamart/callback

LIVE_FRONTEND_URL=https://app.kavach.care
AES_SECRET=<required for token encryption>
```

If redirect URIs are unset, Kavach defaults to `{LIVE_FRONTEND_URL}/api/integrations/{partner}/callback`.

## Local dev (optional)

```env
SWIGGY_MCP_REDIRECT_URI=http://localhost:3000/api/integrations/swiggy/callback
INSTAMART_MCP_REDIRECT_URI=http://localhost:3000/api/integrations/instamart/callback
```

Swiggy OAuth may require redirect URI registration — check Swiggy Builders docs if connect fails with `invalid_redirect_uri`.

## User flow

1. Caregiver opens **Integrations** in Kavach
2. **Connect Swiggy account** or **Connect Instamart account**
3. Complete OTP/OAuth on Swiggy
4. Return to Kavach — status shows `connected_mcp`
5. On order pay, Kavach calls MCP tools (`search_products` / `checkout` for Instamart, food tools for Swiggy)

## Order routing

- Orders created via Saheli today default to **Zepto** partner
- When paying, Kavach uses the order's `partner` field to pick the correct MCP connection
- Instamart/Swiggy orders require the matching account connected in Integrations

## Azure production

Set the four env vars above on the `kavach-backend` Container App alongside existing Zepto vars.
