# Zepto partner outreach (India quick-commerce)

Kavach needs a **partner integration** with Zepto (zeptonow.com) for the suggest → approve → pay → deliver loop. There is no public consumer ordering API.

## What to request from Zepto BD

- B2B / platform API for cart creation from a third-party care app
- Webhooks for order status (confirmed, out for delivery, delivered)
- Pilot program for one family in Bangalore (delivery address on file)
- Sandbox credentials for engineering

## Recommended payment model for MVP

| Model | Description |
|-------|-------------|
| **Caregiver approves in Kavach** | Primary/co-caregiver taps Approve in dashboard or WhatsApp reply |
| **Payment** | Razorpay UPI/card linked to caregiver (not Zepto OAuth) |
| **Fulfillment** | Zepto partner API when available; until then mock adapter + optional deep link to Zepto app |

## Contact angles

- Position Kavach as **care-commerce for elderly families** — recurring grocery + pharmacy baskets suggested by Saheli from Care Record context
- Emphasize **caregiver-in-the-loop approval** for every order
- Offer anonymized pilot metrics after 30 days (orders/week, approval latency)

## Engineering status

- `ZeptoMockAdapter` in `kavach-backend/src/partners/zepto.adapter.ts` implements full write-back to Care Record
- Swap to `ZeptoLiveAdapter` when partner credentials are issued — no dashboard changes required
