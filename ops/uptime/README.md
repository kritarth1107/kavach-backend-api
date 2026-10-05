# Kavach uptime alarm

A Cloudflare Worker that checks, every 5 minutes, from outside Google:

| Check | URL | Healthy when |
| --- | --- | --- |
| Dashboard | `https://app.kavach.care/auth/login` | 2xx/3xx |
| Backend + database | `<backend>/api/health/detailed?HEALTH_SECRET=…` | 200 and `"status": "ok"` (MongoDB answers) |
| Saheli's brain | `<engine>/health` | 200 and `"ok"` |

Two failed checks in a row = down → one email (Resend), a reminder every 6 h while down, and a "recovered" email with
how long it lasted. Monday 09:00 IST: a weekly check-in with each service's uptime, so a broken alarm is noticed too.
`https://kavach-uptime.<account>.workers.dev/status` shows the last round. Free plan is enough (≈ 8,700 runs/month).

## Deploy (once)
```bash
cd kavach-backend/ops/uptime
npx wrangler login                                  # opens Cloudflare in the browser
npx wrangler kv namespace create STATE              # paste the printed id into wrangler.toml
npx wrangler secret put RESEND_API_KEY              # the backend's Resend key (same sender domain emails.kavach.care)
npx wrangler secret put HEALTH_SECRET               # the backend's HEALTH_SECRET (optional; checks the database too)
npx wrangler deploy
```
Change who gets alerts in `wrangler.toml` (`ALERT_TO`, comma-separated) and deploy again.

While the Google project is suspended the backend and engine checks fail, so the first deploy sends a "down" email at
once — that is the alarm working.

## Test
`npm run test:uptime` (from kavach-backend) — the decisions, emails and checks with a fake network; runs in CI.
