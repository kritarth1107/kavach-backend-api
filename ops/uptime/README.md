# Kavach uptime alarm

A Cloudflare Worker that checks from outside Google, every minute for reminders and every 5 minutes for the rest:

| Check | URL | Healthy when |
| --- | --- | --- |
| Dashboard | `https://app.kavach.care/auth/login` | 2xx/3xx |
| Backend + database | `<backend>/api/health/detailed?HEALTH_SECRET=…` | 200 and `"status": "ok"` (MongoDB answers) |
| Saheli's brain | `<engine>/health` | 200 and `"ok"` |
| Reminders (every minute) | `<backend>/api/health/reminders` | 200 and `"status": "ok"` (the reminder tick ran in the last 3 minutes) |

Two failed checks in a row = down. The state is saved. Founder 17 Oct 2026: this worker does not email.
ALERT_TO is empty. The only team email is a crisis alert.
No public URL (cron only). Last round: `npx wrangler kv key get last --binding STATE --remote`. Free plan is enough
(≈ 8,700 runs/month). Deployed 2026-10-05 on account kritarth@kavach.care (workers.dev name `kavach-care`, KV `STATE`).

## Deploy (once)
```bash
cd kavach-backend/ops/uptime
npx wrangler login                                  # opens Cloudflare in the browser
npx wrangler kv namespace create STATE              # paste the printed id into wrangler.toml (done: 675de38b…)
npx wrangler secret put RESEND_API_KEY              # the backend's Resend key (same sender domain emails.kavach.care)
npx wrangler secret put HEALTH_SECRET               # the backend's HEALTH_SECRET (optional; checks the database too)
npx wrangler deploy
```
ALERT_TO stays empty. A deploy does not email.

## Test
`npm run test:uptime` (from kavach-backend) — the decisions, emails and checks with a fake network; runs in CI.

**Storage use:** the Worker writes to KV only when something changes (a failure starts, an alert goes out, a recovery,
the Monday reset), a few writes a day; the free tier allows 1,000. `GET /status` runs a check live and saves nothing.
