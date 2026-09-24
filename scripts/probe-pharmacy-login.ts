/**
 * Dry validation: can deterministic bootstrap reach OTP UI on Apollo/PharmEasy?
 * Does NOT complete an order. Uses a throwaway phone pattern.
 */
import { chromium } from "playwright";
import { bootstrapPharmacyLogin } from "../src/services/commerceAutomation/pharmacyLogin.bootstrap";

const PARTNERS: Array<{ key: string; url: string }> = [
    { key: "apollo", url: "https://www.apollopharmacy.in/" },
    { key: "pharmeasy", url: "https://pharmeasy.in/" },
];

async function probe(partner: string, url: string) {
    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const stages: string[] = [];
    try {
        console.log(`\n=== ${partner} ===`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2000);
        const title = await page.title().catch(() => "");
        console.log("title:", title.slice(0, 80));
        console.log("url:", page.url());
        const boot = await bootstrapPharmacyLogin({
            page,
            partner,
            loginPhone: "+919876543210",
            onProgress: (s, d) => {
                stages.push(`${s}: ${d}`);
                console.log("  progress:", s, d.slice(0, 100));
            },
        });
        console.log("result:", JSON.stringify({ ok: boot.ok, status: boot.status, stage: boot.stage, failureReason: (boot as any).failureReason, message: boot.message.slice(0, 160) }));
        console.log("stages:", stages.join(" | "));
        const shot = `/tmp/saheli-probe-${partner}.png`;
        await page.screenshot({ path: shot, fullPage: false });
        console.log("screenshot:", shot);
        return boot;
    } catch (err) {
        console.error("probe error:", err instanceof Error ? err.message : err);
        try {
            await page.screenshot({ path: `/tmp/saheli-probe-${partner}-err.png`, fullPage: false });
        } catch { /* */ }
        return null;
    } finally {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
    }
}

async function main() {
    for (const p of PARTNERS) {
        await probe(p.key, p.url);
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
