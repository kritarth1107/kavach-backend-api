/** Offline tests: MCP parsers, family address matching, order guardrails. `npx tsx scripts/test-mcp-commerce.ts` */
import {
    checkCart,
    parseFoodCart,
    parseFoodMenu,
    parseInstamartCart,
    parseInstamartSearch,
    parseRestaurantMenu,
    parseRestaurants,
    parseSwiggyAddresses,
    parseZeptoAddresses,
    parseZeptoCart,
    parseZeptoPayment,
    parseZeptoSearch,
    sameStoreAddressId,
    swiggyCodAvailable,
    totalMatchesCard,
} from "../src/services/commerceAutomation/mcpCommerce/mcpParse";
import { storeAddressMatchesPlace } from "../src/services/familyAddressBook.service";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };

const swAddr = `Found 4 saved addresses (page 1 of 1, showing 4):
1. [1704] Kritarth Agrawal: 1704 - Tower 5, M3M Heights, Sector 65, Gurugram, Haryana 122102, India. (M3M Heights) (ID: d1dsqrice8mti3j6gpu0__AbFumQSX7tkWFmPT9FEEGZ)
2. [Kavach Home] Kritarth: C504, SUNITA PARK, LABHANDIH, NEAR TULIP AREA HOTEL, RAIPUR, CHHATTISGARH 492001 (ID: darsuo41d96uh61kgiv0__AUQZ_QTei282Me66PAmkE4)
3. [Home] Kritarth Agrawal: 504, Block C (lilly), Purena, Purena, Chhattisgarh, India (ID: d9qojnc1d96t5colmtvg__AUQaIgTei2sS36wl7t6Yks)

The saved addresses are ranked for display. Suggested/preselected address ID: d1dsqrice8mti3j6gpu0__AbFumQSX7tkWFmPT9FEEGZ.`;
const rows = parseSwiggyAddresses(swAddr);
ok("swiggy addresses parsed", rows.length === 3 && rows[1]!.id.startsWith("darsuo41"));
const place = { line1: "C504, SUNITA PARK, LABHANDIH", pincode: "492001" };
const matches = rows.filter((r) => storeAddressMatchesPlace(r.text, place));
ok("only the Raipur C504 address matches (never the suggested default)", matches.length === 1 && matches[0]!.id.startsWith("darsuo41"));
ok("pincode-less 504 Block C doesn't match", !storeAddressMatchesPlace(rows[2]!.text, place));
ok("short id == listed id", sameStoreAddressId("darsuo41d96uh61kgiv0__AUQZ", "darsuo41d96uh61kgiv0"));
ok("different ids differ", !sameStoreAddressId("d1dsqrice8mti3j6gpu0__x", "darsuo41d96uh61kgiv0"));

const zAddr = `Found 2 saved address(es):

1. Kavach Home: C504, SUNITA PARK, C504 SUNITA PARK NEAR TULIP AREA HOTEL
2. Other: 1704, Tower 5, M3M Heights, Sector 65, Gurugram, Haryana 122102, India

---
Address IDs:
1. "Kavach Home" → ID: 74dab511-e40b-4dc8-879c-082fcbcade25
2. "Other" → ID: b212d1ec-1b85-4519-b9c3-ed637c870049`;
const z = parseZeptoAddresses(zAddr);
ok("zepto addresses parsed", z.length === 2 && z[0]!.id === "74dab511-e40b-4dc8-879c-082fcbcade25" && /SUNITA/.test(z[0]!.text));
ok("zepto Gurugram doesn't match Raipur", !storeAddressMatchesPlace(z[1]!.text, place));

const imSearch = `Found 5 product(s)\n\nDISPLAY INSTRUCTIONS:\n- x\n{\n "products": [ {"displayName":"Amul Taaza Milky Milk","inStock":true,"variations":[{"spinId":"D9PNFAT8MI","skuId":"4XY","quantityDescription":"500 ml x 4","displayName":"Amul Taaza Milky Milk","price":{"mrp":120,"offerPrice":120},"isInStockAndAvailable":false},{"spinId":"SKS75T1GV1","skuId":"VQJ","quantityDescription":"500 ml","displayName":"Amul Taaza Milky Milk","price":{"mrp":30,"offerPrice":29.5},"isInStockAndAvailable":true}]} ]\n}`;
const im = parseInstamartSearch(imSearch);
ok("instamart search: in-stock variation only", im.length === 1 && im[0]!.spinId === "SKS75T1GV1" && im[0]!.pricePaise === 2950);

const zSearch = `Found 10 products for "amul taaza milk":

1. Amul Taaza Homogenised Toned Milk (Tetra Pack) - ₹17 (1 pack (200 ml))
2. Amul Cow Milk Tetra Pack - ₹78 (1 L)

---
Product IDs:
[1] pvid: 2a231315-2b07-4de0-af4a-3a4f9c48ad0c, spid: 470c21fe-4335-41a0-844c-79d94bc0aa2a
[2] pvid: 4906208b-d8b3-45c5-b2b3-5d3f50914e2c, spid: aa880206-d782-5462-b146-a8d6b4db1640`;
const zs = parseZeptoSearch(zSearch);
ok("zepto search parsed", zs.length === 2 && zs[0]!.pvid === "2a231315-2b07-4de0-af4a-3a4f9c48ad0c" && zs[0]!.pricePaise === 1700 && /200 ml/.test(zs[0]!.name));

const menu = `Found 3 menu items for "paneer butter masala":
1. Paneer Butter Masala — ₹399 | Veg | 2.5★ | Dum Safar Biryani (restaurantId: 639469) (ID: 129385235) [has addons]
2. Paneer Butter Masala — ₹200 | Veg | 3.6★ | Ramdev's Khana Khazana (Pachpedi Naka) (restaurantId: 144645) (ID: 83192647)
3. Paneer Thali — ₹250 | Veg | Some Place (restaurantId: 1) (ID: 2) [has variants]`;
const fm = parseFoodMenu(menu);
ok("food menu parsed, variant item skipped", fm.length === 2 && fm[1]!.restaurantId === "144645" && fm[1]!.menuItemId === "83192647" && fm[1]!.restaurantName === "Ramdev's Khana Khazana (Pachpedi Naka)");

const imCart = `Cart retrieved successfully.\n{\n "selectedAddress": "darsuo41d96uh61kgiv0",\n "items": [{"spinId":"SKS75T1GV1","itemName":"Amul Taaza Milky Milk","itemVariant":"500 ml","quantity":1,"discountedFinalPrice":30}],\n "billBreakdown": {"lineItems":[{"label":"Item Total","value":"₹30.00"},{"label":"Handling Fee","value":"₹12.00"}],"toPay":{"label":"To Pay","value":"₹101"}}\n}`;
const ic = parseInstamartCart(imCart);
ok("instamart cart parsed", ic!.lines.length === 1 && ic!.totalPaise === 10100);
ok("instamart cart passes guardrails", checkCart(ic, { id: "SKS75T1GV1", name: "Amul Taaza Milky Milk — 500 ml", qty: 1 }, { needTotal: true }).ok);
ok("qty 2 when user picked 1 → refused", !checkCart({ ...ic!, lines: [{ ...ic!.lines[0]!, qty: 2 }] }, { id: "SKS75T1GV1", name: "x", qty: 1 }).ok);
ok("extra item → refused", !checkCart({ ...ic!, lines: [...ic!.lines, { name: "Chips", qty: 1 }] }, { id: "SKS75T1GV1", name: "x", qty: 1 }).ok);
ok("other item → refused", !checkCart(ic, { id: "OTHER", name: "x", qty: 1 }).ok);
ok("membership line → refused", !checkCart({ ...ic!, feeLines: [...ic!.feeLines, { label: "Swiggy One Lite membership", paise: 9900 }] }, { id: "SKS75T1GV1", name: "x", qty: 1 }).ok);
ok("empty cart → refused", !checkCart({ lines: [], feeLines: [] }, { name: "x", qty: 1 }).ok);

const fc = parseFoodCart(`Items (1):\n  - Paneer Butter Masala — ₹200 (ID: 83192647)\n\nItem total: ₹200\nDelivery: ₹45\nTaxes & charges: ₹51.83\nTO PAY: ₹297\n`);
ok("food cart parsed", fc!.lines.length === 1 && fc!.lines[0]!.id === "83192647" && fc!.totalPaise === 29700 && fc!.feeLines.some((f) => f.label === "Delivery"));
ok("food cart guardrails", checkCart(fc, { id: "83192647", name: "Paneer Butter Masala", qty: 1 }, { needTotal: true }).ok);

const zc = parseZeptoCart(`🛒 Cart Items (1 items)\n      1. Amul Taaza Homogenised Toned Milk (Tetra Pack) - ₹77 (Qty: 1)\n   pvid: 84eae511-5edb-4a22-875e-5aa94976c2d6, spid: 459a`);
ok("zepto cart parsed", zc!.lines.length === 1 && zc!.lines[0]!.id === "84eae511-5edb-4a22-875e-5aa94976c2d6" && zc!.lines[0]!.qty === 1);
const zp = parseZeptoPayment(`💳 **Available Payment Methods**\n\nOrder Total: ₹107\n\n1. **Cash on Delivery** (COD)\n\n2. **Pay Online** (PAYMENT_LINK)\n\nUnavailable methods:\n- Zepto Cash (Wallet): Insufficient`);
ok("zepto COD + total", zp.cod && zp.totalPaise === 10700);
ok("zepto COD only in unavailable block → false", !parseZeptoPayment(`Order Total: ₹107\n1. Pay Online\nUnavailable methods:\n- Cash on Delivery (COD): not available`).cod);
ok("swiggy cod json true", swiggyCodAvailable(`Found…\n{\n "cod": {"available": true, "id": "COD"}\n}`));
ok("swiggy cod json false", !swiggyCodAvailable(`Found…\n{\n "cod": {"available": false, "id": "COD"}\n}`));
ok("total equal ok", totalMatchesCard(10100, 10100));
ok("total +₹1 ok", totalMatchesCard(10100, 10200));
ok("total +₹2 refused", !totalMatchesCard(10100, 10300));
ok("missing total refused", !totalMatchesCard(10100, undefined));

const rs = parseRestaurants(`{"restaurants":[{"id":"556159","name":"Haldiram's Restaurant (Ad)","cuisines":["North Indian","Chaat"],"avgRating":4.3,"deliveryTimeRange":"20-25 MINS","availabilityStatus":"OPEN"},{"id":"1","name":"Closed Place","availabilityStatus":"CLOSED"}]}`);
ok("JSON followed by prose still parses", parseRestaurants(`{"restaurants":[{"id":"1","name":"A \\"B\\" }","availabilityStatus":"OPEN"}]}\n\nIMPORTANT: only recommend OPEN {restaurants}.`).length === 1);
ok("restaurants parsed, (Ad) stripped, open flag", rs.length === 2 && rs[0]!.name === "Haldiram's Restaurant" && rs[0]!.open && !rs[1]!.open);
const rm = parseRestaurantMenu(`Menu for Haldiram's Restaurant (ID: 556159)
## Recommended
  - Chole Bhature — ₹219 | Veg, Bestseller, has variants, has addons [image: https://x/y] (ID: 94218008)
  - Paneer Butter Masala Rice — ₹159 | Veg, Bestseller [image: https://x/z] (ID: 94218165)
## Meals
  ### Rice Bowl
    - Paneer Butter Masala Rice — ₹159 | Veg, Bestseller [image: https://x/z] (ID: 94218165)
    - Rajma Rice — ₹159 | Veg (ID: 156865309)`, "556159", "Haldiram's Restaurant");
ok("restaurant menu: variants skipped, deduped", rm.length === 2 && rm[0]!.menuItemId === "94218165" && rm[0]!.pricePaise === 15900 && rm[1]!.menuItemId === "156865309" && rm[0]!.restaurantId === "556159");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
