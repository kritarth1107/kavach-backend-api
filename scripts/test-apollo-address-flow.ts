/**
 * Apollo signed-in delivery-address step — NO OTP, NO real order, NO real Apollo traffic.
 *
 * Mocked Apollo pages (served via Playwright interception; every other request aborted) that
 * reproduce the real DOM/class names read from Apollo's bundles: the cart's CartAddress block,
 * the "Deliver to" drawer (AddNewAddressRevamped / NewSavedAddressCard), "View Other Saved
 * Address", the location search (NewSearchLocationSuggestor), /address-details (address1 /
 * landmark / disabled pincode+city+state, Save & Next, address type, recipient, Save Address),
 * and the ConfirmCartAddressDialog popup after cart Proceed.
 *
 *   npx tsx scripts/test-apollo-address-flow.ts
 */
import assert from "node:assert/strict";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import {
    addressTargetFrom,
    pickSearchResult,
    savedAddressMatches,
    readCartAddressBlock,
    cartAddressEvidence,
    ctaNeedsAddress,
} from "../src/services/commerceAutomation/apolloAddress";
import { addressEvidenceFromText, runApolloCodCheckout } from "../src/services/commerceAutomation/apolloCheckout";
import { captureCheckoutDiagnostic, getLastCheckoutDiagnostic, redactDiagText } from "../src/services/commerceAutomation/checkoutDiagnostics.service";

const BASE = "https://www.apollopharmacy.in";
const LABEL = "C504, SUNITA PARK, LABHANDIH, NEAR TULIP AREA HOTEL, RAIPUR, CHHATTISGARH, 492001";
const SKU = "Apollo Life Premium Citrus Refreshing Wet Wipes, Pack of 2 (2x30)";
const PROFILE = { name: "Kritarth Singhal", phone: "9876543210" };
const KAVACH_RECIPIENT = "Sunita Devi";

type Addr = {
    id: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    zipcode: string;
    latitude?: number;
    longitude?: number;
    addressType: string;
    name?: string;
    mobileNumber?: string;
    landmark?: string;
};
type Place = { placeId: string; addressName: string; addressDescription: string; pincode: string; city: string; state: string; area: string };
type St = {
    saved: Addr[];
    selectedId: string | null;
    places: Place[];
    pickedPlaceId: string | null;
    editId: string | null;
    searchQueries: string[];
    saveCalls: Array<Record<string, string>>;
    deleteCalls: number;
    placeClicks: number;
    requests: string[];
    forbidden: string[];
    /** "block" = cart with the CartAddress block; "live" = the real signed-in desktop cart seen
     *  on 25 Sep: NO block, header "Deliver to Kritarth Raipur 492012", bottom sticky bar
     *  "Amount to pay ₹192.42" + primary "SELECT ADDRESS" (→ "Proceed" once one is selected). */
    layout: "block" | "live";
    headerPin: string;
    noReviewPopup: boolean;
};
const newState = (p: Partial<St>): St => ({
    saved: [],
    selectedId: null,
    places: [],
    pickedPlaceId: null,
    editId: null,
    searchQueries: [],
    saveCalls: [],
    deleteCalls: 0,
    placeClicks: 0,
    requests: [],
    forbidden: [],
    layout: "block",
    headerPin: "492012",
    noReviewPopup: false,
    ...p,
});
const fmt = (a: Addr) => `${a.addressLine1}, ${a.addressLine2}, ${a.city}, ${a.state} - ${a.zipcode}`;

let HEADER = `<header><span>Delivery Address</span> <span>Raipur 492001</span> <a href="/medicines-cart">Cart</a></header>`;
const setHeader = (st: St) => {
    HEADER =
        st.layout === "live"
            ? `<header><div class="HeaderLocation"><span>Deliver to</span> <b>Kritarth</b> <span>Raipur ${st.headerPin}</span></div> <span class="avatar">K</span> <a href="/medicines-cart">Cart</a></header>`
            : `<header><span>Delivery Address</span> <span>Raipur 492001</span> <a href="/medicines-cart">Cart</a></header>`;
};
function shell(title: string, body: string, script = ""): string {
    return `<!doctype html><html><head><title>${title}</title><style>
.hidden{display:none} [class*="Modalbox"]{position:fixed;top:0;right:0;width:420px;height:100%;background:#fff;border:1px solid #999;overflow:auto;z-index:10}
button,span,[class*="savedAddressChild"],[class*="searchItemList"]{cursor:pointer;display:inline-block;min-width:20px;min-height:16px}
[class*="savedAddressChild"],[class*="searchItemList"]{display:block;padding:6px;border:1px solid #ddd;margin:4px}
</style></head><body>
${HEADER}
<main id="app">${body}</main><script>${script}</script></body></html>`;
}

function cartPage(st: St): string {
    const sel = st.saved.find((a) => a.id === st.selectedId);
    const live = st.layout === "live";
    const block = live
        ? ""
        : sel
        ? `<div class="CartAddress_addressMain__V7zoa"><div class="CartAddress_addressBlock__KHt2Q"><div class="CartAddress_adressIcon__DQrWA"></div><div class="CartAddress_addressRightBx__NSyGg"><div class="CartAddress_addressDetail__k1chb"><p class="CartAddress_cusName__6HeZX"><span class="CartAddress_billToTxt__3TvJN"> Bill to </span>${sel.name || PROFILE.name}</p><p class="CartAddress_address__Nt8hI">${fmt(sel)}</p></div><div class="CartAddress_addActions__HESr9"><span class="CartAddress_actionBtn__HJq2T" id="act">Change</span></div></div></div></div>`
        : `<div class="CartAddress_addressMain__V7zoa"><div class="CartAddress_addressBlock__KHt2Q CartAddress_addAdressBlock__sLaQL"><div class="CartAddress_adressIcon__DQrWA"></div><div class="CartAddress_addressRightBx__NSyGg"><div class="CartAddress_addressDetail__k1chb"><p class="CartAddress_cusName__6HeZX"><span class="CartAddress_billToTxt__3TvJN"> Bill to </span>${PROFILE.name}</p><p class="CartAddress_address__Nt8hI">Raipur 492001</p></div><div class="CartAddress_addressAction__clmEn"><span class="undefined" id="act">${st.saved.length ? "SELECT ADDRESS" : "ADD ADDRESS"}</span></div></div></div></div>`;
    return shell(
        "Your Cart | Apollo Pharmacy",
        `<h1>YOUR CART</h1><p>1 ITEM IN YOUR CART</p>${block}
<div class="MedicineProductCard_root__udJYP"><div class="MedicineProductCard_titleBx__V"><h2 class="MedicineProductCard_title__MJ4MD">${SKU}</h2></div><p class="MedicineProductCard_text__lcvKS">Qty 1</p></div>
<h3>Cart Breakdown</h3><p>Total Bill Incl. charges 279 192.42</p>
${live
    ? `<div class="CartFooter_root" style="position:fixed;bottom:0;left:0;right:0;background:#fff"><div class="CartFooter_amt"><p class="CartFooter_lbl">Amount to pay<span class="CartFooter_chev"></span></p><p class="CartFooter_val">₹192.42</p></div><div class="CartFooter_cta"><button class="Button_primaryPharma" id="proceed">${sel ? "Proceed" : st.saved.length ? "SELECT ADDRESS" : "ADD ADDRESS"}</button></div></div>`
    : `<p>Amount to pay</p><p>₹192.42</p><button title="Proceed" id="proceed">Proceed</button>`}
<div id="drawer"></div>`,
        `
const saved = ${JSON.stringify(st.saved)}; const selected = ${JSON.stringify(sel || null)}; const noReview = ${JSON.stringify(st.noReviewPopup)};
const fmt = a => a.addressLine1 + ', ' + a.addressLine2 + ', ' + a.city + ', ' + a.state + ' - ' + a.zipcode;
const card = (a, i) => '<div class="NewSavedAddressCard_savedAddressChild__qpbH-" data-id="' + a.id + '"><div class="NewSavedAddressCard_addressType__4PcLi"><div class="NewSavedAddressCard_heading__lhm66"><div class="NewSavedAddressCard_sentenceCase__8OE3R">' + a.addressType.toLowerCase() + '</div></div><div class="NewSavedAddressCard_iconSection__KWTEl"><i class="del" style="display:inline-block;width:14px;height:14px;background:#c00"></i></div></div><div class="NewSavedAddressCard_addressDesc__iB4Jq">' + fmt(a) + '</div></div>';
const post = (u, b) => fetch(u, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(b || {}) }).then(r => r.json());
const D = document.getElementById('drawer');
function bindCards() {
  D.querySelectorAll('[class*="savedAddressChild"]').forEach(c => c.addEventListener('click', async (e) => {
    if (e.target.classList.contains('del')) { await post('/__mock/delete', { id: c.dataset.id }); return; }
    const r = await post('/__mock/select', { id: c.dataset.id });
    if (r.needsUpdate) { D.insertAdjacentHTML('beforeend', '<p>Selected address needs to be updated.</p>'); setTimeout(() => location.href = '/address-details?view=map', 400); return; }
    D.innerHTML = ''; setTimeout(() => location.reload(), 300);
  }));
}
function openSheet() {
  let h = '<div class="AddNewAddressRevamped_AddressModalboxClass__J6pfq" role="dialog"><h2 class="AddNewAddressRevamped_modalTitle__oA6E8">Deliver to</h2>';
  if (saved.length) {
    h += '<div class="AddNewAddressRevamped_savedAddressHeading__QZCDZ">Choose from Saved Address</div>' + card(selected || saved[0]);
    if (saved.length > 1) h += '<button class="AddNewAddressRevamped_viewAddressCta__SqY9f" id="viewOther">View Other Saved Address</button>';
    h += '<div class="AddNewAddressRevamped_separator__TEecL"><span class="AddNewAddressRevamped_text__icyUo">or</span></div>';
  }
  h += '<button class="AddNewAddressRevamped_locationBtn__SLFk2">Current Location</button><div class="AddNewAddressRevamped_separator__TEecL"><span class="AddNewAddressRevamped_text__icyUo">or</span></div>';
  h += '<button class="AddNewAddressRevamped_locationBtn__SLFk2" id="addNew"><span class="ico"></span>Add New Address</button></div>';
  D.innerHTML = h; bindCards();
  const vo = document.getElementById('viewOther');
  if (vo) vo.addEventListener('click', () => {
    D.innerHTML = '<div class="AddNewAddressRevamped_AddressModalboxClass__J6pfq" role="dialog"><h2>Deliver to </h2><div class="AddNewAddressRevamped_savedAddressHeading__QZCDZ AddNewAddressRevamped_topMargin__HqYxO">Choose from saved address</div>' + saved.map(card).join('') + '</div>';
    bindCards();
  });
  document.getElementById('addNew').addEventListener('click', () => {
    D.innerHTML = '<div class="AddNewAddressRevamped_AddressModalboxClass__J6pfq AddNewAddressRevamped_hideRadius__piqPl" role="dialog"><h2>Deliver to</h2><div class="NewSearchLocationSuggestor_searchSection__0FSMP"><input type="text" id="q" placeholder="Search for society, locality, pincode..."></div><div id="res"></div></div>';
    let t; document.getElementById('q').addEventListener('input', (e) => {
      clearTimeout(t); const v = e.target.value; const R = document.getElementById('res');
      if (v.length < 3) { R.innerHTML = ''; return; }
      R.innerHTML = '<div>Searching...</div>';
      t = setTimeout(async () => {
        const r = await fetch('/__mock/search?q=' + encodeURIComponent(v)).then(x => x.json());
        if (!r.length) { R.innerHTML = '<div class="NewSearchLocationSuggestor_noResult">No Result found, Try searching for other location</div>'; return; }
        R.innerHTML = '<ul><div class="NewSearchLocationSuggestor_heading__NAWCC">Search Results</div>' + r.map(p => '<div class="NewSearchLocationSuggestor_searchItemList__w+jEQ" data-pid="' + p.placeId + '"><h3 class="NewSearchLocationSuggestor_title__A4XSH">' + p.addressName + '</h3><p class="NewSearchLocationSuggestor_subTitle__Rb9SB">' + p.addressDescription + '</p></div>').join('') + '</ul>';
        R.querySelectorAll('[data-pid]').forEach(el => el.addEventListener('click', async () => { await post('/__mock/pick', { placeId: el.dataset.pid }); location.href = '/address-details?view=map'; }));
      }, 350);
    });
  });
}
const actEl = document.getElementById('act'); if (actEl) actEl.addEventListener('click', openSheet);
document.getElementById('proceed').addEventListener('click', () => {
  if (!selected) { openSheet(); return; }
  if (noReview) { location.href = '/delivery-options'; return; }
  D.innerHTML = '<div class="ConfirmCartAddressDialog_AddressModalboxClass__rAY-q" role="dialog"><h2>Deliver to</h2><div class="ConfirmCartAddressDialog_heading">Delivery Address</div><div class="NewSavedAddressCard_savedAddressChild__x"><div class="desc">' + fmt(selected) + '</div></div><button class="ConfirmCartAddressDialog_changBtn__T1tWj">Change Address</button><div class="ConfirmCartAddressDialog_extraInfo__Pgn3F"><label>Recipient*</label><input type="text" id="rn" value="' + (selected.name || '') + '"><label>Recipient Contact*</label><input type="tel" name="recipientContact" id="rc" value="' + (selected.mobileNumber || '') + '"><p>Double-check the details so your order reaches the right hands!</p></div><div class="actions"><button id="rvProceed">Proceed</button></div></div>';
  D.querySelector('.ConfirmCartAddressDialog_changBtn__T1tWj').addEventListener('click', openSheet);
  document.getElementById('rvProceed').addEventListener('click', () => {
    if (!document.getElementById('rn').value.trim() || !/^[6789]\\d{9}$/.test(document.getElementById('rc').value)) return;
    location.href = '/delivery-options';
  });
});`,
    );
}

function addressDetailsPage(st: St): string {
    const place = st.places.find((p) => p.placeId === st.pickedPlaceId);
    const edit = st.saved.find((a) => a.id === st.editId);
    const pin = place?.pincode || edit?.zipcode || "";
    const city = place?.city || edit?.city || "";
    const state = place?.state || edit?.state || "";
    const area = place?.area || edit?.addressLine2 || "";
    return shell(
        "Address Details | Apollo Pharmacy",
        `<div class="addressDetails-module-scss-module__4WXb2q__addressRoot"><div class="map">[map] Your order will be delivered here</div>
<div class="addressDetails-module-scss-module__4WXb2q__addressForm" id="form" style="visibility:hidden">
<h2>Enter Address Details</h2><div class="tabs"><div>Address Details</div><div>Recipient Details</div></div>
<div id="tab1"><label>House/ Floor/ Flat Number<span>*</span></label><textarea name="address1" aria-label="address1" rows="1">${edit?.addressLine1 || ""}</textarea>
<div> Area Details </div><input id="address2" name="address2" aria-label="address2" disabled value="">
<label>Landmark (This will help rider to reach you faster)</label><input id="landmark" aria-label="landmark" type="text" name="landmark" value="">
<input id="pincode" name="pincode" aria-label="pincode" disabled value=""><input id="city" name="city" aria-label="city" disabled value=""><input id="state" name="state" aria-label="state" disabled value="">
<button aria-label="Save and proceed to next step" id="next">Save &amp; Next</button></div>
<div id="tab2" class="hidden"><fieldset><legend>Who are you ordering for?*</legend><label><input type="radio" name="orderingFor" value="myself" checked>Myself</label><label><input type="radio" name="orderingFor" value="someone else">Someone else</label></fieldset>
<fieldset><legend>Save this address as*</legend>${["HOME", "OFFICE", "FRIENDSANDFAMILY", "OTHER"].map((t) => `<button type="button" id="${t}" name="addressType" aria-label="Select ${t} as address type">${t.toLowerCase()}</button>`).join("")}<span id="typeErr"></span></fieldset>
<label>Recipient*</label><input name="recipientName" aria-label="recipient name" value="${edit?.name || PROFILE.name}">
<label>Phone Number*</label>+91<input type="tel" name="recipientContact" aria-label="recipient contact" maxlength="10" value="${edit?.mobileNumber || PROFILE.phone}">
<div>Billing will be done using the name on the prescription</div><button aria-label="Save Address" id="save">Save Address</button></div></div></div>`,
        `
// Geocode arrives async (like Apollo's map lookup)
setTimeout(() => {
  document.getElementById('address2').value = ${JSON.stringify(area)};
  document.getElementById('pincode').value = ${JSON.stringify(pin)};
  document.getElementById('city').value = ${JSON.stringify(city)};
  document.getElementById('state').value = ${JSON.stringify(state)};
  document.getElementById('form').style.visibility = 'visible';
}, 900);
let type = '';
document.getElementById('next').addEventListener('click', () => { document.getElementById('tab1').classList.add('hidden'); document.getElementById('tab2').classList.remove('hidden'); });
document.querySelectorAll('button[name="addressType"]').forEach(b => b.addEventListener('click', () => { type = b.id; document.querySelectorAll('button[name="addressType"]').forEach(x => x.className = ''); b.className = 'active'; }));
document.getElementById('save').addEventListener('click', async () => {
  if (!type) { document.getElementById('typeErr').textContent = 'Please select one from above'; return; }
  const body = { address1: document.querySelector('textarea[name="address1"]').value, landmark: document.getElementById('landmark').value,
    recipientName: document.querySelector('input[name="recipientName"]').value, recipientContact: document.querySelector('input[name="recipientContact"]').value, addressType: type };
  const r = await fetch('/__mock/save-address', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) }).then(x => x.json());
  if (!r.ok) { document.body.insertAdjacentHTML('beforeend', '<p>Failed to save address</p>'); return; }
  setTimeout(() => location.href = '/medicines-cart', 500);
});`,
    );
}

async function installMock(ctx: BrowserContext, st: St): Promise<void> {
    await ctx.route("**/*", async (route: Route) => {
        const req = route.request();
        const url = req.url();
        st.requests.push(`${req.method()} ${url}`);
        if (/otp|login|signin|generateotp/i.test(url)) {
            st.forbidden.push(url);
            return route.abort();
        }
        if (!url.startsWith(BASE)) return route.abort();
        const u = new URL(url);
        const html = (b: string) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: b });
        const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
        const body = () => JSON.parse(req.postData() || "{}") as Record<string, string>;
        switch (u.pathname) {
            case "/__mock/cart":
                return json({ cart: [{ name: SKU, qty: 1 }] });
            case "/__mock/select": {
                const a = st.saved.find((x) => x.id === body().id);
                if (!a) return json({ ok: false });
                if (a.latitude == null) {
                    st.editId = a.id;
                    return json({ needsUpdate: true });
                }
                st.selectedId = a.id;
                return json({ ok: true });
            }
            case "/__mock/delete":
                st.deleteCalls++;
                return json({ ok: true });
            case "/__mock/search": {
                const q = (u.searchParams.get("q") || "").toLowerCase();
                st.searchQueries.push(q);
                const words = q.split(/\s+/).filter((w) => w.length > 2);
                return json(st.places.filter((p) => words.some((w) => `${p.addressName} ${p.addressDescription}`.toLowerCase().includes(w))));
            }
            case "/__mock/pick":
                st.pickedPlaceId = body().placeId;
                st.editId = null;
                return json({ ok: true });
            case "/__mock/save-address": {
                const b = body();
                st.saveCalls.push(b);
                const place = st.places.find((p) => p.placeId === st.pickedPlaceId);
                const edit = st.saved.find((a) => a.id === st.editId);
                const base = place
                    ? { addressLine2: place.area, city: place.city, state: place.state, zipcode: place.pincode }
                    : { addressLine2: edit!.addressLine2, city: edit!.city, state: edit!.state, zipcode: edit!.zipcode };
                const a: Addr = {
                    id: edit?.id || `new${st.saved.length + 1}`,
                    addressLine1: b.address1!,
                    ...base,
                    latitude: 21.25,
                    longitude: 81.66,
                    addressType: b.addressType!,
                    name: b.recipientName,
                    mobileNumber: b.recipientContact,
                    landmark: b.landmark,
                };
                st.saved = st.saved.filter((x) => x.id !== a.id).concat(a);
                st.selectedId = a.id;
                return json({ ok: true });
            }
            case "/medicines-cart":
                return html(cartPage(st));
            case "/address-details":
                return html(addressDetailsPage(st));
            case "/delivery-options": {
                const a = st.saved.find((x) => x.id === st.selectedId);
                return html(shell("Delivery options", `<h2>Choose delivery type</h2><p>Delivering to ${a ? fmt(a) : ""}</p><button id="go">PROCEED</button>`,
                    `document.getElementById('go').addEventListener('click', () => { location.href = '/pay/9001'; });`));
            }
            default:
                if (u.pathname.startsWith("/pay/")) {
                    return html(shell("Payment", `<h2>Payment options</h2><p>Amount to pay ₹192.42</p>
<div class="codContainer__a"><div class="codCard__b"><div role="button" id="codHead">Pay on Delivery</div><input type="radio" id="checkbox-cod"></div>
<button id="place" aria-label="Pay rupees 192.42">Place order for ₹192.42</button></div>`,
                        `document.getElementById('codHead').addEventListener('click', () => { document.getElementById('checkbox-cod').checked = true; });
document.getElementById('place').addEventListener('click', async () => { await fetch('/__mock/place', { method: 'POST' }); location.href = '/order-status/TXN77/success'; });`));
                }
                if (u.pathname === "/__mock/place") {
                    st.placeClicks++;
                    return json({ ok: true });
                }
                return html(shell("Apollo", "<p>home</p>"));
        }
    });
}

async function withPage<T>(st: St, fn: (p: Page) => Promise<T>): Promise<T> {
    setHeader(st);
    const browser = await chromium.launch({ headless: true });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await installMock(ctx, st);
        const p = await ctx.newPage();
        p.on("pageerror", (e) => console.log("  [page error]", e.message.slice(0, 200)));
        return await fn(p);
    } finally {
        await browser.close();
    }
}

function assertNoLeaks(st: St): void {
    assert.deepEqual(st.forbidden, [], "no OTP / login traffic");
    assert.deepEqual(st.requests.filter((r) => !r.split(" ")[1]!.startsWith(BASE)), [], "no traffic outside the mock");
    assert.equal(st.deleteCalls, 0, "never clicked a saved-address delete icon");
}

const target = addressTargetFrom(LABEL)!;
const checkout = (p: Page, progress: string[], log: string[]) =>
    runApolloCodCheckout(p, {
        deadlineAt: Date.now() + 140_000,
        pincode: "492001",
        addressHints: ["C504", "SUNITA PARK"],
        addressTarget: target,
        recipientName: KAVACH_RECIPIENT,
        accountPhone: "+919876543210",
        confirmedTotalRupees: 192.42,
        skuName: SKU,
        dryRun: true, // stop right before Place order even on the mock
        geminiMaxSteps: 0,
        progress: async (d) => {
            progress.push(d);
        },
        log: (e, x) => log.push(`${e} ${x ? JSON.stringify(x) : ""}`),
    });

async function main() {
    // ── unit ──
    assert.equal(target.pincode, "492001");
    assert.equal(target.flat, "C504");
    assert.equal(target.society, "Sunita Park");
    assert.equal(target.area, "Labhandih");
    assert.equal(target.landmark, "Near Tulip Area Hotel");
    assert.equal(target.city, "Raipur");
    assert.equal(target.state, "Chhattisgarh");
    assert.equal(target.line1, "C504, Sunita Park");
    assert.deepEqual(target.searchQueries, ["Sunita Park Labhandih Raipur", "Sunita Park Raipur", "Labhandih Raipur", "492001"]);
    const short = addressTargetFrom("C504 Sunita Park, Labhandih, Raipur 492001")!;
    assert.equal(short.flat, "C504");
    assert.equal(short.society, "Sunita Park");
    assert.equal(short.city, "Raipur");
    assert.ok(savedAddressMatches("c-504 , SUNITA PARK, LABHANDIH, RAIPUR, CHHATTISGARH - 492001", target));
    assert.ok(savedAddressMatches("Flat C 504, Near Tulip, Labhandih, Raipur, Chhattisgarh - 492001", target));
    assert.ok(savedAddressMatches("Sunita-Park Society, Labhandih, Raipur - 492001", target));
    assert.ok(!savedAddressMatches("C504, Sunita Park, Raipur - 492013", target), "wrong pincode");
    assert.ok(!savedAddressMatches("Flat 12, Shanti Nagar, Raipur - 492001", target), "same pincode, other street");
    assert.ok(!savedAddressMatches("Raipur 492001", target), "header browse location is not an address");
    const pick = pickSearchResult(
        [
            { i: 0, text: "Sunita Park Kota, Rajasthan 324005" },
            { i: 1, text: "Labhandih Raipur, Chhattisgarh" },
            { i: 2, text: "Sunita Park Labhandih, Raipur, Chhattisgarh 492001, India" },
        ],
        target,
    );
    assert.equal(pick?.i, 2, "best search row = Sunita Park, Labhandih, Raipur 492001");
    assert.equal(pickSearchResult([{ i: 0, text: "Sunita Park Kota, Rajasthan" }], target), null, "other city rejected");
    assert.equal(redactDiagText("call 9876543210 or +91 98765 43210, OTP is 519319"), "call [phone] or [phone], OTP is [redacted]");
    console.log("✓ unit: address parsing / saved-address matching / diag redaction");

    // ── A) account has NO saved address → Add New Address → search → form → save → select ──
    {
        const st = newState({
            places: [
                { placeId: "p-far", addressName: "Sunita Park", addressDescription: "Kota, Rajasthan 324005", pincode: "324005", city: "Kota", state: "Rajasthan", area: "Kota" },
                { placeId: "p1", addressName: "Sunita Park", addressDescription: "Labhandih, Raipur, Chhattisgarh 492001, India", pincode: "492001", city: "Raipur", state: "Chhattisgarh", area: "Labhandih, Raipur" },
            ],
        });
        const progress: string[] = [];
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            const before = await readCartAddressBlock(p);
            assert.equal(before.selected, false, "nothing selected (only the browse 'Raipur 492001')");
            assert.equal(cartAddressEvidence(before, target), "none", "browse location is NOT counted as an address");
            return checkout(p, progress, log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.saveCalls.length, 1, "exactly one address saved");
        const saved = st.saveCalls[0]!;
        assert.equal(saved.address1, "C504, Sunita Park");
        assert.equal(saved.landmark, "Near Tulip Area Hotel");
        assert.equal(saved.recipientName, KAVACH_RECIPIENT, "care recipient's name from Kavach");
        assert.equal(saved.recipientContact, PROFILE.phone, "Apollo's own prefilled account phone kept");
        assert.equal(saved.addressType, "HOME");
        const sel = st.saved.find((a) => a.id === st.selectedId)!;
        assert.equal(sel.zipcode, "492001");
        assert.ok(st.searchQueries[0]!.includes("sunita park"), st.searchQueries.join(" | "));
        assert.ok(st.requests.some((r) => /\/pay\//.test(r)), "reached /pay after the address popup");
        assert.equal(st.placeClicks, 0);
        assertNoLeaks(st);
        console.log("✓ A no saved address: added C504, Sunita Park (Labhandih, Raipur 492001), selected, popup confirmed, reached COD (dry run)");
        console.log("  progress:", JSON.stringify(progress));
        console.log("  saved:", JSON.stringify(saved));
    }

    // ── B) saved address in a different format, not the first card → View Other → select it ──
    {
        const st = newState({
            saved: [
                { id: "a1", addressLine1: "Flat 12, Shanti Nagar", addressLine2: "Tatibandh", city: "Raipur", state: "Chhattisgarh", zipcode: "492099", latitude: 21.2, longitude: 81.6, addressType: "OFFICE", name: PROFILE.name, mobileNumber: PROFILE.phone },
                { id: "a2", addressLine1: "c-504 , SUNITA PARK", addressLine2: "LABHANDIH NEAR TULIP HOTEL", city: "RAIPUR", state: "CHHATTISGARH", zipcode: "492001", latitude: 21.25, longitude: 81.66, addressType: "HOME", name: PROFILE.name, mobileNumber: PROFILE.phone },
            ],
        });
        const progress: string[] = [];
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return checkout(p, progress, log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.selectedId, "a2", "picked the matching saved address");
        assert.equal(st.saveCalls.length, 0, "no new address created");
        assert.equal(st.searchQueries.length, 0, "no location search");
        assert.equal(st.placeClicks, 0);
        assertNoLeaks(st);
        console.log("✓ B saved address in a different format (c-504 , SUNITA PARK … - 492001), hidden behind 'View Other Saved Address': selected, no new address");
        console.log("  progress:", JSON.stringify(progress));
    }

    // ── C) Apollo's map puts the place in another pincode → stop, save nothing ──
    {
        const st = newState({
            places: [{ placeId: "p2", addressName: "Sunita Park", addressDescription: "Labhandih, Raipur, Chhattisgarh", pincode: "492013", city: "Raipur", state: "Chhattisgarh", area: "Labhandih" }],
        });
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            const res = await checkout(p, [], log);
            await captureCheckoutDiagnostic(p, { familyId: "fam-test", userId: "u-test", flow: "checkout", stage: out_stage(res), reason: `${res.status}: ${res.detail}` });
            return res;
        });
        assert.equal(out.status, "address_unverified", JSON.stringify(out));
        assert.match(out.detail, /pincode 492013, not 492001/);
        assert.equal(st.saveCalls.length, 0, "never saved a wrong-pincode address");
        assert.ok(!st.requests.some((r) => /\/delivery-options|\/pay\//.test(r)), "never went past the cart");
        assertNoLeaks(st);
        const diag = getLastCheckoutDiagnostic("fam-test", "u-test")!;
        assert.ok(diag && diag.url.endsWith("/address-details?view=map"), JSON.stringify(diag?.url));
        assert.ok(!/9876543210/.test(diag.text), "phone redacted from diag text");
        assert.ok((diag.screenshotBytes ?? 0) > 1000 && diag.screenshotJpegBase64, "masked screenshot captured");
        console.log("✓ C map pincode 492013 ≠ 492001 → stopped, nothing saved/placed; diagnostic captured (url, text, masked screenshot)");
        console.log("  detail:", out.detail);
        console.log("  diag:", JSON.stringify({ stage: diag.stage, url: diag.url, text: diag.text.slice(0, 160), bytes: diag.screenshotBytes }));
    }

    // ── D) matching address already selected → no picker at all ──
    {
        const st = newState({
            saved: [{ id: "a2", addressLine1: "C504, Sunita Park", addressLine2: "Labhandih", city: "Raipur", state: "Chhattisgarh", zipcode: "492001", latitude: 21.25, longitude: 81.66, addressType: "HOME", name: PROFILE.name, mobileNumber: PROFILE.phone }],
            selectedId: "a2",
        });
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return checkout(p, [], []);
        });
        assert.equal(out.status, "dry_run_stop", JSON.stringify(out));
        assert.equal(st.saveCalls.length + st.searchQueries.length, 0);
        assertNoLeaks(st);
        console.log("✓ D matching address already selected → straight to Proceed / popup / COD (dry run)");
    }

    // ── E) matching saved address WITHOUT map coordinates → Apollo opens its editor → save → selected ──
    {
        const st = newState({
            saved: [
                { id: "a1", addressLine1: "Flat 12, Shanti Nagar", addressLine2: "Tatibandh", city: "Raipur", state: "Chhattisgarh", zipcode: "492099", latitude: 21.2, longitude: 81.6, addressType: "OFFICE", name: PROFILE.name, mobileNumber: PROFILE.phone },
                { id: "a3", addressLine1: "C 504 Sunita Park", addressLine2: "Labhandih", city: "Raipur", state: "Chhattisgarh", zipcode: "492001", addressType: "HOME", name: PROFILE.name, mobileNumber: PROFILE.phone },
            ],
        });
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return checkout(p, [], log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.selectedId, "a3", "the same saved address was updated + selected (no duplicate)");
        assert.equal(st.saveCalls.length, 1);
        assert.equal(st.saved.length, 2);
        assertNoLeaks(st);
        console.log("✓ E saved address missing map coordinates → Apollo's editor → updated + selected, no duplicate");
    }

    // ── unit: header "Deliver to <name> <city> <pin>" is browse location only ──
    assert.equal(addressEvidenceFromText("Deliver to Kritarth Raipur 492001 1 K Buy Medicines YOUR CART 1 ITEM Amount to pay ₹192.42 SELECT ADDRESS", "492001", ["C504"]), "none");
    assert.equal(addressEvidenceFromText("Delivery Address Select Address Raipur 492001 Choose delivery type Delivering to", "492001", ["C504"]), "none");
    assert.equal(addressEvidenceFromText("Deliver to Kritarth Raipur 492012 Choose delivery type Delivering to C504, Sunita Park, Labhandih, Raipur - 492001", "492001", ["C504"]), "full");
    console.log("✓ unit: header 'Deliver to <name> <city> <pin>' never counts as the delivery pincode");

    // ── F) LIVE layout (no block, header 492012, bottom SELECT/ADD ADDRESS), no saved address → add new ──
    {
        const st = newState({
            layout: "live",
            places: [
                { placeId: "p1", addressName: "Sunita Park", addressDescription: "Labhandih, Raipur, Chhattisgarh 492001, India", pincode: "492001", city: "Raipur", state: "Chhattisgarh", area: "Labhandih, Raipur" },
            ],
        });
        const progress: string[] = [];
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            const before = await readCartAddressBlock(p);
            assert.equal(before.found, false, "no CartAddress block (live layout)");
            assert.equal(before.cta, "ADD ADDRESS", JSON.stringify(before));
            assert.ok(ctaNeedsAddress(before));
            assert.match(before.header, /Deliver to Kritarth Raipur 492012/);
            assert.equal(cartAddressEvidence(before, target), "none");
            return checkout(p, progress, log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.saveCalls.length, 1, "exactly one address saved");
        assert.equal(st.saveCalls[0]!.address1, "C504, Sunita Park");
        assert.equal(st.saveCalls[0]!.recipientName, KAVACH_RECIPIENT);
        assert.equal(st.saved.find((a) => a.id === st.selectedId)!.zipcode, "492001");
        assert.ok(log.some((l) => l.startsWith("address_review_result") && l.includes('"ok":true')), "verified on Apollo's Deliver-to popup before payment");
        assert.ok(st.requests.some((r) => /\/pay\//.test(r)));
        assert.equal(st.placeClicks, 0);
        assertNoLeaks(st);
        console.log("✓ F live layout (no block, header 492012, bottom ADD ADDRESS), no saved address → added + selected via bottom button, verified on the popup, reached COD (dry run)");
        console.log("  progress:", JSON.stringify(progress));
    }

    // ── G) LIVE layout, bottom SELECT ADDRESS, matching saved address in another format behind View Other ──
    {
        const st = newState({
            layout: "live",
            saved: [
                { id: "a1", addressLine1: "Flat 12, Shanti Nagar", addressLine2: "Tatibandh", city: "Raipur", state: "Chhattisgarh", zipcode: "492012", latitude: 21.2, longitude: 81.6, addressType: "OFFICE", name: PROFILE.name, mobileNumber: PROFILE.phone },
                { id: "a2", addressLine1: "c-504 , SUNITA PARK", addressLine2: "LABHANDIH NEAR TULIP HOTEL", city: "RAIPUR", state: "CHHATTISGARH", zipcode: "492001", latitude: 21.25, longitude: 81.66, addressType: "HOME", name: PROFILE.name, mobileNumber: PROFILE.phone },
            ],
        });
        const progress: string[] = [];
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            const before = await readCartAddressBlock(p);
            assert.equal(before.cta, "SELECT ADDRESS");
            return checkout(p, progress, log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.selectedId, "a2");
        assert.equal(st.saveCalls.length + st.searchQueries.length, 0, "no new address, no search");
        assert.ok(log.some((l) => l.startsWith("address_review_result") && l.includes('"ok":true')));
        assertNoLeaks(st);
        console.log("✓ G live layout, bottom SELECT ADDRESS → drawer → View Other → 'c-504 , SUNITA PARK … - 492001' selected, verified on popup (dry run)");
        console.log("  progress:", JSON.stringify(progress));
    }

    // ── H) LIVE layout, another saved address pre-selected (bottom already Proceed), header shows 492001 ──
    {
        const st = newState({
            layout: "live",
            headerPin: "492001",
            saved: [
                { id: "a1", addressLine1: "Flat 12, Shanti Nagar", addressLine2: "Tatibandh", city: "Raipur", state: "Chhattisgarh", zipcode: "492099", latitude: 21.2, longitude: 81.6, addressType: "OFFICE", name: PROFILE.name, mobileNumber: PROFILE.phone },
                { id: "a2", addressLine1: "C504, Sunita Park", addressLine2: "Labhandih", city: "Raipur", state: "Chhattisgarh", zipcode: "492001", latitude: 21.25, longitude: 81.66, addressType: "HOME", name: PROFILE.name, mobileNumber: PROFILE.phone },
            ],
            selectedId: "a1",
        });
        const progress: string[] = [];
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return checkout(p, progress, log);
        });
        assert.equal(out.status, "dry_run_stop", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.equal(st.selectedId, "a2", "switched via the popup's Change Address");
        assert.equal(st.saveCalls.length, 0);
        assertNoLeaks(st);
        console.log("✓ H live layout, wrong address pre-selected (header says 492001 — ignored) → popup mismatch → Change Address → C504 selected → verified (dry run)");
        console.log("  progress:", JSON.stringify(progress));
    }

    // ── I) LIVE layout, wrong address pre-selected, NO popup, header 492001 → must stop before payment ──
    {
        const st = newState({
            layout: "live",
            headerPin: "492001",
            noReviewPopup: true,
            saved: [
                { id: "a1", addressLine1: "Flat 12, Shanti Nagar", addressLine2: "Tatibandh", city: "Raipur", state: "Chhattisgarh", zipcode: "492099", latitude: 21.2, longitude: 81.6, addressType: "OFFICE", name: PROFILE.name, mobileNumber: PROFILE.phone },
            ],
            selectedId: "a1",
        });
        const log: string[] = [];
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return checkout(p, [], log);
        });
        assert.equal(out.status, "address_unverified", `${JSON.stringify(out)}\n${log.join("\n")}`);
        assert.ok(!st.requests.some((r) => /\/pay\//.test(r)), "never reached payment");
        assert.equal(st.placeClicks, 0);
        assertNoLeaks(st);
        console.log("✓ I live layout, wrong address, no popup, header 'Deliver to Kritarth Raipur 492001' → stopped before payment:", out.detail);
    }

    console.log("\nALL APOLLO ADDRESS FLOW TESTS PASSED (mocked Apollo, no OTP, no real order)");
    process.exit(0);
}

function out_stage(o: { status: string; stage?: string }): string {
    return o.stage || o.status;
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
