# Family address book (nicknamed places)

Every Kavach flow that needs an address — Saheli on WhatsApp (Apollo, PharmEasy, Instamart,
Swiggy, Blinkit, Zepto, Zomato, Uber pickup/drop), dashboard orders and MCP store checkouts —
resolves it from ONE place: the family's address book (`family_addresses`,
`src/services/familyAddressBook.service.ts`).

## Rules

- A place belongs to exactly one family (`familyId`). There is no global / env / code default
  and no fallback to another family's address or to an address saved on a store account.
- Places have a nickname that is unique per family ("Home", "Beta's flat", "Clinic").
- `memberUserIds` = the members a place applies to (empty = everyone in the family).
- `defaultForUserIds` = members whose default place this is (at most one default per member).
- Resolver order: place named in the message → place confirmed for the current order/ride
  (kept 45 min) → member's default (explicit default → "Home" → most recently used).
  Nothing saved → Saheli asks once and saves the answer.
- Store checkouts use the chosen place only. Before Place order the address shown by the store
  must match it on **pincode AND the flat / society line**; otherwise Saheli stops. Store-account
  addresses (MCP) are shown/used only when they match a place in the book.
- Legacy per-person rows (`recipient_delivery_addresses`) are migrated once into the book as
  "Home" (default for that person) and marked `migratedAt`; they are no longer read.

## WhatsApp behaviour (Gemini router — no regex routing)

The router sees the family's saved nicknames (nickname + city + pincode only) and returns
`addressNickname` (exactly one of them), `addressKind/addressText` (a typed address) or
`placeName` (the name given for a new place).

| Situation | Saheli |
|---|---|
| Order, places saved, nothing chosen yet | "Deliver to *Home* 🏠 (…)? Reply *yes*, or pick another saved place: 2. Beta's flat — … 3. Clinic — …" |
| "yes" / "haan" / "2" / "clinic" | uses that place (remembered for this order), then searches |
| Order names a place ("atta bhejo beta ke ghar") | uses it directly, no extra question |
| New full address typed | saves it to the book, uses it, asks once "What should I call this place?" |
| No places at all | asks once for the full address with pincode, saves it as *Home* |
| "where will it be delivered?" | lists the saved places and the default |
| Ride "clinic se ghar" | pickup = Clinic, drop = Home (saved places), other places resolved near the elder's city |

If the router is unavailable, a plain-text fallback handles yes / a number / a nickname / a
typed address at the confirm step.

## REST API

Base: `/api/families/:familyId/addresses` — JWT (`Authorization: Bearer …`). The caller must be a
JOINED member of the family (403 otherwise, same as the activity routes). Reads: any joined
member. Writes: primary or co-caregiver.

Responses are `{ success: true, data: … }`. Errors: 400 validation, 403 access, 404 not found,
409 nickname already used in this family.

### Address object

```json
{
  "addressId": "uuid",
  "nickname": "Home",
  "line1": "Flat 12, Lake View Apartments, Shyamla Hills",
  "line2": null,
  "landmark": "Near Lake Gate",
  "city": "Bhopal",
  "state": "Madhya Pradesh",
  "pincode": "462002",
  "lat": null,
  "lng": null,
  "contactName": null,
  "contactPhone": null,
  "fullAddress": "Flat 12, Lake View Apartments, Shyamla Hills, Near Lake Gate, Bhopal, Madhya Pradesh 462002",
  "memberUserIds": [],
  "defaultForUserIds": ["<elder userId>"],
  "isDefaultForMember": true,
  "createdByUserId": "<userId>",
  "source": "dashboard | whatsapp | migration",
  "lastUsedAt": "ISO | null",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

(`isDefaultForMember` is present only when listing with `?memberUserId=`.)

### Endpoints

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/api/families/:familyId/addresses` | `?memberUserId=` (optional) | `{ addresses: [...] }`, member's default first when `memberUserId` is given |
| POST | `/api/families/:familyId/addresses` | `nickname` (required) + either `address` (one line, parsed) or `line1` + `pincode` (+ `line2`, `landmark`, `city`, `state`, `lat`, `lng`, `contactName`, `contactPhone`, `memberUserIds`, `defaultForUserIds`) | 201 `{ address }` |
| GET | `/api/families/:familyId/addresses/:addressId` | — | `{ address }` |
| PATCH | `/api/families/:familyId/addresses/:addressId` | any of the POST fields (`null` clears optional fields) | `{ address }` |
| DELETE | `/api/families/:familyId/addresses/:addressId` | — | `{ deleted: true }` |
| PUT | `/api/families/:familyId/addresses/:addressId/default` | `{ "memberUserId": "…" }` | makes it that member's only default |

Validation: `pincode` = 6 digits, not starting with 0; `nickname` ≤ 40 chars, unique per family
(case / punctuation-insensitive); `memberUserIds` / `defaultForUserIds` / `memberUserId` must be
joined members of this family; `contactPhone` 10–13 digits; `lat` / `lng` in range.

## Ops (mock secret header required)

- `POST /api/webhooks/whatsapp/mock/address-book` `{ "from": "<phone>" }` → that sender's
  family places, PII-light (nickname, first 3 chars of line1, city, pincode, default, chosen).
- `POST /api/webhooks/whatsapp/mock/privacy-audit` now also reports `addressBook` rows per family.

## Tests

`NODE_ENV=test npx tsx scripts/test-family-address-book.ts` (pure helpers). With a throwaway
local mongod: `TEST_MONGODB_URI=mongodb://127.0.0.1:27999/abtest …` also runs migration,
defaults, nickname resolution, cross-family isolation and API auth checks.
