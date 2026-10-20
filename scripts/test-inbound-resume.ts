/** A killed WhatsApp task is resumed once. An answered message is not. No Mongo. */
import { claimDecision } from "../src/services/whatsappInboundDedupe.service";
import { holdingLineDue } from "../src/services/whatsappInbound.service";

const now = Date.now();
const payload = { text: "BP le li" };

if (claimDecision(null, now) !== "new") throw new Error("a new message should be processed");
if (claimDecision({ payload, leasedUntil: new Date(now + 60_000), attempts: 1 }, now) !== "busy") throw new Error("a live worker should not be interrupted");
if (claimDecision({ payload, leasedUntil: new Date(now - 1000), attempts: 1 }, now) !== "resume") throw new Error("a dead worker should be resumed");
if (claimDecision({ payload, answeredAt: new Date(now - 1000), leasedUntil: new Date(now - 1000) }, now) !== "done") throw new Error("an answered message is once");
if (claimDecision({ leasedUntil: new Date(now - 1000) }, now) !== "done") throw new Error("an old claim without a payload is not replayed");
if (claimDecision({ payload, leasedUntil: new Date(now - 1000), attempts: 3 }, now) !== "done") throw new Error("three tries is enough");

// one "still on it" line per person per burst (live 20 Oct: four in a row)
if (!holdingLineDue("+910000000001", now)) throw new Error("the first slow message gets the line");
if (holdingLineDue("+910000000001", now + 20_000)) throw new Error("a second slow message in the burst does not");
if (!holdingLineDue("+910000000002", now + 20_000)) throw new Error("another person still gets theirs");
if (!holdingLineDue("+910000000001", now + 130_000)) throw new Error("a later slow message gets one again");

console.log("ok");
