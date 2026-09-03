# Order loop architecture (Phase 1)

Suggest → approve → pay → write-back for Zepto grocery/pharmacy baskets.

## Flow

1. **Suggest** — Saheli (or caregiver) proposes items → `order_suggested` Care Record event + `Order` row (`awaiting_approval`)
2. **Approve** — Primary/co-caregiver via dashboard Approvals or WhatsApp reply → `order_approved`
3. **Pay** — Razorpay when `RAZORPAY_KEY_ID` is set; otherwise mock payment in pilot → `order_paid`
4. **Deliver** — Partner webhook or mock adapter → `order_delivered`

## Services

| Component | Path |
|-----------|------|
| Order service | `src/services/order.service.ts` |
| Zepto adapter | `src/partners/zepto.adapter.ts` |
| Approvals API | `GET /api/families/:familyId/approvals/pending` |
| Dashboard | `/dashboard/approvals` |

## Payment model

Caregiver approves in Kavach; payment uses caregiver-linked UPI/card (Razorpay) or mock in pilot. Not per-user Zepto OAuth.

## Partner track

See `docs/partners/zepto-outreach.md` for live Zepto API outreach. Until partner API exists, mock adapter writes real Care Record events and optional deep link handoff.
