/**
 * Unit tests (no network, no DB, no browser) for the Saheli agent-layer changes:
 * interrupt classifier rules, health red-flag net, allowlist, MCP removal, progress routing,
 * caregiver WhatsApp policy, nudge single-message.  Run: npx tsx scripts/test-saheli-agent-layer.ts
 */
process.env.VERTEX_DISABLED = "1";
import assert from "node:assert/strict";
import { classifyOrderInterruptRules } from "../src/services/commerceAutomation/orderInterrupt.service";
import { detectHealthRedFlagRules, formatRedFlagAlert } from "../src/services/saheliHealthRedFlag.service";
import { isAllowedOrderSite, isFoodGroceryBrowserOnly, refuseSiteCopy } from "../src/services/commerceAutomation/siteAllowlist";
import { shouldPreferBrowserForPartner, shouldPreferMcpForPartner } from "../src/services/commerceAutomation/commerceBrowserFirst";
import { shouldForwardProgressToWhatsApp } from "../src/services/commerceAutomation/browserProgressNotify.service";
import { caregiverWhatsAppAllowed, claimCaregiverAlert, formatCaregiverOrderPlaced } from "../src/services/saheliCaregiverAlert.service";
import { extractEtaLabel, workingAckCopy } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";
import { buildCareNudgeMessages } from "../src/services/whatsappMessageComposer.service";
import { payCommerceOrder } from "../src/partners/commerce.adapter";
import { OrderPartner } from "../src/types/careRecord.types";
import { redactActivityText } from "../src/services/activityLog.service";
import { quietLongEnough, sessionHasActiveFlow } from "../src/services/saheliNudgeGate.service";

let pass = 0;
async function t(name: string, fn: () => void | Promise<void>) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}`);
        throw err;
    }
}

(async () => {
    console.log("interrupt classifier (rules)");
    const c = (x: string, phase = "running") => classifyOrderInterruptRules(x, phase)?.intent ?? "ambiguous";
    await t("cancel variants", () => {
        for (const x of ["cancel", "Stop", "rehne do", "cancel the order", "nahi chahiye"]) assert.equal(c(x), "cancel", x);
    });
    await t("flow replies incl. OTP digits", () => {
        for (const x of ["confirm", "haan", "2", "482913", "retry", "order again"]) assert.equal(c(x, "awaiting_otp"), "flow_reply", x);
    });
    await t("status questions", () => {
        for (const x of ["status", "where is my order", "kab aayega?", "is it placed yet"]) assert.equal(c(x), "status", x);
    });
    await t("change item/qty/address", () => {
        assert.equal(c("get the 500mg one instead"), "change");
        assert.equal(classifyOrderInterruptRules("make it 2", "awaiting_confirm")?.quantity, 2);
        assert.equal(c("deliver to 12 MG Road Indore 452001"), "change");
        assert.equal(c("dolo 650", "awaiting_sku_confirm"), "change");
    });
    await t("unrelated chat goes to companion", () => {
        for (const x of ["good morning", "what's the weather today?", "tell me a joke", "remind me at 6pm to call Ravi", "I have back pain"]) {
            assert.equal(c(x), "unrelated", x);
        }
    });

    console.log("health red flags (keyword net)");
    await t("hits", () => {
        const cases: Record<string, string> = {
            "I have chest pain since morning": "chest_pain",
            "seene me dard ho raha hai": "chest_pain",
            "I fell down in the bathroom": "fall",
            "main gir gayi": "fall",
            "feeling very dizzy": "dizziness",
            "chakkar aa rahe hain": "dizziness",
            "can't breathe properly": "breathing",
            "I don't want to live anymore": "self_harm",
            "forgot my insulin today": "missed_critical_meds",
            "there is blood in my urine": "bleeding",
            "I feel so lonely and hopeless": "low_mood",
        };
        for (const [x, cat] of Object.entries(cases)) assert.equal(detectHealthRedFlagRules(x), cat, x);
    });
    await t("no false alarm on routine / negated", () => {
        for (const x of ["order milk from zepto", "good morning beta", "no chest pain today, feeling good", "not dizzy anymore"]) {
            assert.equal(detectHealthRedFlagRules(x), null, x);
        }
    });
    await t("alert copy never diagnoses", () => {
        const m = formatRedFlagAlert({ elderName: "Amma", category: "chest_pain", quote: "chest pain" });
        assert.match(m, /Health alert — Amma/);
        assert.match(m, /112/);
        assert.match(m, /can't diagnose/);
    });
    await t("dedupe window", () => {
        assert.equal(claimCaregiverAlert("k1", 1000, 0), true);
        assert.equal(claimCaregiverAlert("k1", 1000, 500), false);
        assert.equal(claimCaregiverAlert("k1", 1000, 1600), true);
    });

    console.log("allowlist + browser-only food/grocery");
    await t("allowlist", () => {
        for (const p of ["apollo", "pharmeasy", "instamart", "swiggy", "zepto", "blinkit", "zomato", "uber"]) assert.ok(isAllowedOrderSite(p), p);
        for (const p of ["amazon", "flipkart", "bigbasket", "tata_1mg", "ola", "rapido", "generic", undefined]) assert.ok(!isAllowedOrderSite(p), String(p));
        assert.match(refuseSiteCopy("amazon"), /can't order from Amazon/);
    });
    await t("MCP never preferred; browser forced for the five (even with env off)", () => {
        process.env.COMMERCE_BROWSER_FIRST = "0";
        for (const p of ["instamart", "swiggy", "zepto", "blinkit", "zomato"]) {
            assert.ok(shouldPreferBrowserForPartner(p), p);
            assert.ok(!shouldPreferMcpForPartner(p), p);
            assert.ok(isFoodGroceryBrowserOnly(p), p);
        }
        delete process.env.COMMERCE_BROWSER_FIRST;
    });
    await t("payCommerceOrder refuses MCP place for Instamart/Swiggy/Zepto", async () => {
        for (const partner of [OrderPartner.INSTAMART, OrderPartner.SWIGGY, OrderPartner.ZEPTO]) {
            await assert.rejects(
                payCommerceOrder({ partner, orderId: "o1", amountPaise: 100, payerUserId: "u", familyId: "f", items: [{ name: "milk", quantity: 1 }] }),
                /on the website now/,
            );
        }
    });

    console.log("progress → logs, WhatsApp only for OTP");
    await t("forward only otp_ready", () => {
        assert.equal(shouldForwardProgressToWhatsApp("otp_ready"), true);
        for (const s of ["launching", "opening", "searching", "checkout", "post_otp", "busy", undefined]) {
            assert.equal(shouldForwardProgressToWhatsApp(s), false, String(s));
        }
        assert.ok(workingAckCopy("apollo").length < 130);
    });

    console.log("caregiver WhatsApp policy");
    await t("only orders + health red flags (+ elder-requested share)", () => {
        for (const k of ["order_placed", "health_red_flag", "emergency", "symptom", "lab_alert", "missed_tasks", "elder_share"]) {
            assert.ok(caregiverWhatsAppAllowed(k), k);
        }
        for (const k of ["ride", "prescription_draft", "care_alert", "browse"]) assert.ok(!caregiverWhatsAppAllowed(k, "medium"), k);
        assert.ok(caregiverWhatsAppAllowed(undefined, "high"));
        assert.ok(!caregiverWhatsAppAllowed(undefined, "medium"));
    });
    await t("order-placed copy has item, total, COD, ETA, id", () => {
        const m = formatCaregiverOrderPlaced({ elderName: "Amma", partnerLabel: "Apollo", item: "Limcee 500mg", totalLabel: "₹98", etaLabel: "Sat, 27 Sep", orderId: "360184572" });
        for (const re of [/Amma placed/, /Limcee/, /₹98/, /Cash on Delivery/, /ETA: Sat, 27 Sep/, /360184572/]) assert.match(m, re);
        assert.equal(extractEtaLabel("Order placed! Delivery by Sat, 27 Sep."), "Sat, 27 Sep");
        assert.equal(extractEtaLabel("Order placed."), undefined);
    });

    console.log("nudges + redaction");
    await t("care nudge = one message, no trailing follow-up", () => {
        const msgs = buildCareNudgeMessages({ text: "Amma, time for your BP tablet 💊", nudgeKind: "pre_reminder", scheduleId: "s1", title: "BP", time: "09:00" });
        assert.equal(msgs.length, 1);
        assert.ok(!JSON.stringify(msgs).includes("Anything else"));
    });
    await t("activity redaction masks OTP + phone", () => {
        const r = redactActivityText("OTP 482913 sent to +91 76948 29888")!;
        assert.ok(!r.includes("482913") && !r.includes("76948"), r);
    });

    console.log("nudge gate");
    await t("quiet window 60 min", () => {
        const now = Date.now();
        assert.equal(quietLongEnough(new Date(now - 59 * 60_000), now, 60 * 60_000), false);
        assert.equal(quietLongEnough(new Date(now - 61 * 60_000), now, 60 * 60_000), true);
        assert.equal(quietLongEnough(null, now, 60 * 60_000), true);
    });
    await t("active flows block nudges", () => {
        assert.match(String(sessionHasActiveFlow({ browserTaskDraft: { phase: "running" } })), /browser_order/);
        assert.match(String(sessionHasActiveFlow({ browserTaskDraft: { phase: "awaiting_confirm" } })), /awaiting_confirm/);
        assert.match(String(sessionHasActiveFlow({ rideDraft: { phase: "awaiting_otp" } })), /ride/);
        assert.match(String(sessionHasActiveFlow({ pharmacyDraft: { phase: "confirm_basket" } })), /pharmacy/);
        assert.equal(sessionHasActiveFlow({ pendingCommerceOtp: { partner: "apollo" } }), "otp_wait");
        assert.equal(sessionHasActiveFlow({ browserTaskDraft: { phase: "done" }, rideDraft: { phase: "idle" } }), null);
        assert.equal(sessionHasActiveFlow({}), null);
    });

    console.log(`\nAll ${pass} passed`);
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
