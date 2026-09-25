/** Unit tests: food intent, address-only detection, address stripping, dynamic pick copy. Run: npx tsx scripts/test-food-address-flow.ts */
import assert from "node:assert/strict";
import { extractFoodQuery, isAddressOnlyMessage, replyPickCopy, wantsRestaurantList } from "../src/services/commerceAutomation/foodOrderFlow";
import { addressMatches, cityOf, classifyAddressMention, locationQueryFor, shortAddress, stripAddressPhrases } from "../src/services/commerceAutomation/kavachAddress";
import { parseAddressReply } from "../src/services/commerceAutomation/recipientAddress.service";
import { resolveDeliveryAddressLabel } from "../src/services/commerceAutomation/smokeDeliveryAddress";
// Fictional address — tests never use a real family's address.
const HOME = "B12, Green Park, Arera Colony, Near Lotus Hotel, Bhopal, Madhya Pradesh, 462001";
import { messageLooksLikeBrowserTask } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";
import { classifyOrderInterruptRules } from "../src/services/commerceAutomation/orderInterrupt.service";
import { rankGroceryItems } from "../src/services/commerceAutomation/guestCatalogSearch.service";
let pass = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("✓", n); } catch (e) { console.error("✗", n, e); process.exitCode = 1; } };
t("restaurant intent", () => {
    assert.ok(messageLooksLikeBrowserTask("Lets try ordering from swiggy show me open restaurant in b12"));
    assert.ok(messageLooksLikeBrowserTask("Order from swiggy food to my bhopal address"));
    assert.ok(messageLooksLikeBrowserTask("show me open restaurants"));
    assert.ok(wantsRestaurantList("show me open restaurant in b12"));
    assert.equal(extractFoodQuery("Lets try ordering from swiggy show me open restaurant in b12", HOME), "");
    assert.equal(extractFoodQuery("Order from swiggy food to my bhopal address", HOME), "");
    assert.equal(extractFoodQuery("order paneer butter masala from swiggy"), "paneer butter masala");
    assert.equal(extractFoodQuery("show me biryani restaurants near me"), "biryani");
});
t("address-only messages", () => {
    assert.ok(isAddressOnlyMessage("I want it delivered to my home address of bhopal b12", HOME));
    assert.ok(isAddressOnlyMessage("order Inwant it delivered home address of bhopal b12 from Instamart", HOME));
    assert.ok(!isAddressOnlyMessage("order milk delivered to my home"));
    assert.ok(!isAddressOnlyMessage("show me open restaurants"));
    assert.equal(classifyAddressMention("I want it delivered to my home address of bhopal b12", HOME), "same");
    assert.equal(classifyAddressMention("deliver to sector 45 gurgaon 122003", HOME), "other");
    assert.equal(classifyAddressMention("what is the weather"), null);
});
t("address phrases never become a product", () => {
    assert.equal(stripAddressPhrases("order milk and deliver it to my home in bhopal b12", HOME), "order milk");
    assert.equal(stripAddressPhrases("order milk to my green park address", HOME), "order milk");
    assert.equal(locationQueryFor(HOME), "Green Park Arera Colony Bhopal");
    assert.equal(cityOf(HOME), "Bhopal");
    assert.equal(cityOf("12 MG Road, Indiranagar, Bengaluru 560038"), "Bengaluru");
    assert.equal(shortAddress(HOME), "B12, Green Park, Arera Colony, Bhopal 462001");
    assert.ok(addressMatches("Green Park, Bhopal - 462001", HOME));
    assert.ok(!addressMatches("Sector 45, Gurugram 122003", HOME));
    assert.ok(!addressMatches("anything 462001", undefined), "no saved address never matches");
});
t("interrupt rules: delivered-to = change(address)", () => {
    const r = classifyOrderInterruptRules("I want it delivered to my home address of bhopal b12", "awaiting_sku_confirm");
    assert.equal(r?.intent, "change");
    assert.ok(r?.address);
    assert.equal(classifyOrderInterruptRules("4", "awaiting_restaurant_pick")?.intent, "flow_reply");
});
t("dynamic pick copy", () => {
    assert.equal(replyPickCopy(2), "Reply *1* or *2*");
    assert.equal(replyPickCopy(3), "Reply *1*, *2* or *3*");
    assert.equal(replyPickCopy(5), "Reply a number *1*–*5*");
});
t("grocery relevance", () => {
    const r = rankGroceryItems("milk", [{ name: "Cadbury Dairy Milk Chocolate Bar" }, { name: "Amul Taaza Toned Milk" }, { name: "Mix Beans 200g" }, { name: "Amul Dairy Whitener" }]);
    assert.deepEqual(r.map((x) => x.name), ["Amul Taaza Toned Milk"]);
});
t("per-recipient address: parse + no default", async () => {
    assert.equal(parseAddressReply("my address is B12, Green Park, Arera Colony, Bhopal 462001")?.pincode, "462001");
    assert.equal(parseAddressReply("B12 Green Park Bhopal"), null, "needs a pincode");
    assert.equal(parseAddressReply("462001"), null, "needs street text");
    assert.equal(await resolveDeliveryAddressLabel({}), null, "no family/recipient → no address (never a default)");
});
setTimeout(() => console.log(`${pass} passed`), 200);
