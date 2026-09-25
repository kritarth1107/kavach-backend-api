# Caregiver activity feed + daily snapshot — API contract (v1, 2026-09-26)

Stable contract for kavach-dashboard. Backend owner: kavach-backend. If this changes, this file is updated first.

Base URL: `https://kavach-backend-303943038694.asia-south1.run.app` (prod). All routes are under `/api/families`
(same router + conventions as `.../care-record/timeline`).

## Auth
- Header `Authorization: Bearer <access token>` (existing `protect` middleware — same token the dashboard already uses).
- Caller must be a **JOINED caregiver** (`PRIMARY_CAREGIVER` or `CO_CAREGIVER`) of `:familyId`, and
  `:subjectUserId` must be a JOINED `CARE_RECIPIENT` of that family.
- Errors (existing envelope): `403 {"success":false,"message":"..."}` (not a caregiver / not in family),
  `404` (recipient not found), `400` (bad query), `401` (no/expired token).

All success responses use the existing envelope: `{"success": true, "data": ... }`.
Timestamps are ISO-8601 UTC strings (`2026-09-25T20:41:03.120Z`); render in IST. `dayKey` is the **IST** calendar day `YYYY-MM-DD`.

---

## 1. Activity feed

`GET /api/families/:familyId/subjects/:subjectUserId/activity`

Query params (all optional):
| param | type | default | notes |
|---|---|---|---|
| `day` | `YYYY-MM-DD` (IST) | — | only that IST day. Omit for "latest across days". |
| `before` | ISO timestamp | — | pagination cursor: return items with `createdAt < before` (use `nextBefore`). |
| `kinds` | comma list of kinds | all | e.g. `kinds=order_placed,order_failed,health`. |
| `limit` | int 1–500 | 200 | |

Response `200`:
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "66f4c2a1e1b2c3d4e5f60718",
        "kind": "order_step",
        "title": "Apollo: checkout",
        "detail": "selecting Cash on Delivery…",
        "severity": "info",
        "dayKey": "2026-09-26",
        "createdAt": "2026-09-25T20:41:03.120Z",
        "actorUserId": "usr_…",
        "data": { "stage": "checkout", "partner": "apollo" }
      }
    ],
    "nextBefore": "2026-09-25T20:40:11.004Z",
    "hasMore": true
  }
}
```
- `items` newest first. `nextBefore` = `createdAt` of the last item when `hasMore`, else `null`.
- `detail` is plain text (may contain WhatsApp `*bold*` markers; strip or render). OTPs/phone numbers are redacted server-side (`••••`).
- `data` is optional, kind-specific, and never required for rendering (see table). Unknown keys must be ignored.

### Event kinds (`kind`)
| kind | meaning | typical `data` keys |
|---|---|---|
| `message_in` | elder texted Saheli | — |
| `voice_note` | elder sent a voice note (`detail` = transcript) | — |
| `message_out` | Saheli's reply to the elder | `source?: "browser"` |
| `order_step` | background order progress step (not sent to WhatsApp) | `stage` (`launching`/`opening`/`login_page`/`otp_ready`/`searching`/`post_otp`/`checkout`/…), `partner` |
| `order_confirm_card` | confirm card (item/total/address) shown to elder | `status`, `confirm: {items?: string[], totalLabel?, addressLabel?}`, `partner?` |
| `order_placed` | order placed (COD) | `status` (`placed`/`placed_unverified`), `orderIds?`, `totalLabel?`, `payment: "COD"` |
| `order_failed` | order stopped / failed honestly | `status`, `failureReason?` |
| `order_cancelled` | elder cancelled | `phase?`, `checkoutInFlight?` |
| `order_interrupt` | elder messaged during an order | `phase`, `intent` (`cancel`/`change`/`status`/`flow_reply`/`unrelated`), `source` |
| `ride` | ride booking event | `provider?`, `from?`, `to?` |
| `reminder` | reminder created/fired/done | `reminderId?`, `status?` |
| `mood` | mood mention/check-in | `mood?` |
| `health` | health mention / red flag | `category` (e.g. `chest_pain`, `fall`, `dizziness`, `breathing`, `self_harm`, `missed_critical_meds`, `low_mood`, `other_concern`), `source` (`rules`/`gemini`), `deduped?` |
| `caregiver_alert` | an alert to caregivers was raised | `kind`, `urgency`, `whatsapp: boolean` |
| `diag` | browser diagnostics (optional screenshot) | `screenshotDataUrl?` (small JPEG data URL), `url?`, `stage?` |

`severity`: `info` | `warn` | `error` (`error` = health red flag / emergency — highlight it).
New kinds may be added later; render unknown kinds generically with `title` + `detail`.

---

## 2. Daily snapshot

### Get
`GET /api/families/:familyId/subjects/:subjectUserId/daily-snapshot?day=YYYY-MM-DD`
- `day` optional, default = today (IST).

Response `200`:
```json
{
  "success": true,
  "data": {
    "snapshot": {
      "dayKey": "2026-09-26",
      "status": "ready",
      "summary": "Amma had a calm morning…",
      "highlights": ["Ordered Limcee 500mg from Apollo (₹98, COD) — order 360184572"],
      "concerns": ["Mentioned dizziness around 4 pm — caregiver was alerted"],
      "mood": "calm",
      "counts": { "messages": 14, "voiceNotes": 2, "orders": 1, "rides": 0, "reminders": 3, "healthFlags": 1 },
      "model": "gemini-3.5-pro",
      "generatedAt": "2026-09-26T15:30:00.000Z",
      "source": "scheduled"
    }
  }
}
```
- `snapshot` is `null` when none exists yet for that day (UI: show "Generate snapshot").
- `status`: `ready` | `generating` | `failed` | `empty` (no activity that day; `summary` explains).
- `mood`: free short word or `null`. `highlights` / `concerns`: arrays of short strings (may be empty).
- `source`: `scheduled` | `on_demand`.

### Generate / regenerate (on demand)
`POST /api/families/:familyId/subjects/:subjectUserId/daily-snapshot`
Body (optional): `{ "day": "YYYY-MM-DD" }` (default today IST).
Response `200`: same shape as GET (`data.snapshot`, `status: "ready"` or `"failed"`). May take up to ~30 s.
Rate limit: 1 regeneration per recipient per day per 2 minutes → `429 {"success":false,"message":"..."}`.

### List (for a calendar strip)
`GET /api/families/:familyId/subjects/:subjectUserId/daily-snapshots?limit=14`
Response `200`: `{"success":true,"data":{"snapshots":[ <snapshot>, ... ]}}` newest first (`limit` 1–60, default 14).

Schedule: backend generates yesterday's + today's snapshot automatically each evening (~21:00 IST) for recipients with activity.

---

## Notes for the dashboard
- No images or message bodies are pushed to caregivers on WhatsApp; this feed is the place to see them.
- Caregiver WhatsApp is only sent for (1) orders placed by the elder and (2) health red flags; both also appear here
  (`order_placed`, `health` + `caregiver_alert`).
