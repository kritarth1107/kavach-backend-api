/** Remote-browser gating: only BROWSER_REMOTE=browseruse + key + allowlisted partners go remote. */
import assert from "assert";
import { useRemoteBrowserFor, remoteSites } from "../src/services/commerceAutomation/remoteBrowser";

const save = { ...process.env };
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    for (const k of ["BROWSER_REMOTE", "BROWSER_USE_API_KEY", "BROWSER_REMOTE_SITES"]) delete process.env[k];
    Object.assign(process.env, env);
    try {
        fn();
    } finally {
        process.env = { ...save };
    }
}
withEnv({}, () => assert.equal(useRemoteBrowserFor("zomato"), false, "off by default"));
withEnv({ BROWSER_REMOTE: "browseruse" }, () => assert.equal(useRemoteBrowserFor("zomato"), false, "no key → local"));
withEnv({ BROWSER_REMOTE: "browseruse", BROWSER_USE_API_KEY: "x" }, () => {
    for (const p of ["blinkit", "instamart", "swiggy", "zomato", "zepto"]) assert.equal(useRemoteBrowserFor(p), true, p);
    // Trial 2: cab + pharmacy sites load fine on our own browser → stay local.
    for (const p of ["apollo", "pharmeasy", "tata_1mg", "uber", "ola", "amazon", "", null]) assert.equal(useRemoteBrowserFor(p as string), false, String(p));
});
withEnv({ BROWSER_REMOTE: "browseruse", BROWSER_USE_API_KEY: "x", BROWSER_REMOTE_SITES: "blinkit, uber" }, () => {
    assert.deepEqual([...remoteSites()], ["blinkit", "uber"]);
    assert.equal(useRemoteBrowserFor("uber"), true);
    assert.equal(useRemoteBrowserFor("zomato"), false);
});
withEnv({ BROWSER_REMOTE: "local", BROWSER_USE_API_KEY: "x" }, () => assert.equal(useRemoteBrowserFor("blinkit"), false));
console.log("remote-browser gating: all tests passed");
