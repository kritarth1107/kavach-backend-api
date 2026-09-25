/** Local smoke: Stagehand attaches over CDP to our Playwright Chromium and acts on an explicit Action (no LLM). */
import { chromium } from "playwright";
import { debugPortArgs, registerBrowserDebugPort, cdpUrlForBrowser } from "../src/services/commerceAutomation/agentLayer/cdpRegistry";
async function main() {
    const port = 9300 + Math.floor(Math.random() * 700);
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", ...debugPortArgs(port)] });
    registerBrowserDebugPort(browser, port);
    const page = await browser.newPage();
    await page.setContent(`<button id="b" onclick="document.title='clicked'">Proceed</button>`);
    const cdpUrl = await cdpUrlForBrowser(browser);
    console.log("cdpUrl", Boolean(cdpUrl));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { V3 } = require("@browserbasehq/stagehand");
    const sh = new V3({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl }, model: { modelName: "vertex/gemini-3.5-flash", providerOptions: { vertex: { project: "kavach-care", location: "asia-south1" } } }, disablePino: true, verbose: 0, logger: () => undefined, experimental: true });
    await sh.init();
    const r = await sh.act({ selector: "xpath=/html/body/button", description: "Proceed", method: "click", arguments: [] }, { page });
    console.log("act", r.success, "title", await page.title());
    await sh.close();
    console.log("playwright page still alive:", !page.isClosed(), await page.evaluate(() => 1 + 1));
    await browser.close();
}
main().catch((e) => { console.error("FAIL", e?.message || e); process.exit(1); });
