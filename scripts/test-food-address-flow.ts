/** Unit tests: food intent, address-only detection, address stripping, dynamic pick copy. Run: npx tsx scripts/test-food-address-flow.ts */
import assert from "node:assert/strict";
import { extractFoodQuery, isAddressOnlyMessage, replyPickCopy, wantsRestaurantList } from "../src/services/commerceAutomation/foodOrderFlow";
import { classifyAddressMention, locationQueryFor, stripAddressPhrases } from "../src/services/commerceAutomation/kavachAddress";
import { messageLooksLikeBrowserTask } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";
import { classifyOrderInterruptRules } from "../src/services/commerceAutomation/orderInterrupt.service";
import { rankGroceryItems } from "../src/services/commerceAutomation/guestCatalogSearch.service";
let pass = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("✓", n); } catch (e) { console.error("✗", n, e); process.exitCode = 1; } };
t("restaurant intent", () => {
    assert.ok(messageLooksLikeBrowserTask("Lets try ordering from swiggy show me open restaurant in c504"));
    assert.ok(messageLooksLikeBrowserTask("Order from swiggy food to my raipur address"));
    assert.ok(messageLooksLikeBrowserTask("show me open restaurants"));
    assert.ok(wantsRestaurantList("show me open restaurant in c504"));
    assert.equal(extractFoodQuery("Lets try ordering from swiggy show me open restaurant in c504"), "");
    assert.equal(extractFoodQuery("Order from swiggy food to my raipur address"), "");
    assert.equal(extractFoodQuery("order paneer butter masala from swiggy"), "paneer butter masala");
    assert.equal(extractFoodQuery("show me biryani restaurants near me"), "biryani");
});
t("address-only messages", () => {
    assert.ok(isAddressOnlyMessage("I want it delivered to my home address of raipur c504"));
    assert.ok(isAddressOnlyMessage("order Inwant it delivered home address of raipur c504 from Instamart"));
    assert.ok(!isAddressOnlyMessage("order milk delivered to my home"));
    assert.ok(!isAddressOnlyMessage("show me open restaurants"));
    assert.equal(classifyAddressMention("I want it delivered to my home address of raipur c504"), "same");
    assert.equal(classifyAddressMention("deliver to sector 45 gurgaon 122003"), "other");
    assert.equal(classifyAddressMention("what is the weather"), null);
});
t("address phrases never become a product", () => {
    assert.equal(stripAddressPhrases("order milk and deliver it to my home in raipur c504"), "order milk");
    assert.equal(locationQueryFor(), "SUNITA PARK LABHANDIH RAIPUR");
});
t("interrupt rules: delivered-to = change(address)", () => {
    const r = classifyOrderInterruptRules("I want it delivered to my home address of raipur c504", "awaiting_sku_confirm");
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
console.log(`${pass} passed`);
