/**
 * Unit checks for the nudge silence streak: counting, follow-up planning, WhatsApp reply
 * threading (context.message_id) and the once-per-streak caregiver alert rule.
 * No DB, no network (fetch stubbed, dummy Meta creds).
 *
 *   npx tsx scripts/test-nudge-streak.ts
 */
import assert from "node:assert/strict";

process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_META_PHONE_NUMBER_ID = "TEST_PHONE_ID";
process.env.WHATSAPP_META_ACCESS_TOKEN = "TEST_TOKEN";

const bodies: Array<Record<string, unknown>> = [];
let n = 0;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    n += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.T${n}` }] }), { status: 200 });
}) as typeof fetch;

const H = 3_600_000;
const M = 60_000;

async function main() {
    const s = await import("../src/services/saheliNudgeStreak.service");
    const client = await import("../src/clients/metaWhatsApp.client");
    let passed = 0;
    const ok = (name: string) => {
        passed += 1;
        console.log(`  ✓ ${name}`);
    };

    // Sat 26 Sep 2026, IST times
    const at = (hhmm: string, day = 26) => new Date(`2026-09-${day}T${hhmm}:00+05:30`);
    const nudge = (id: string, when: Date, wamid?: string) => ({
        nudgeId: id,
        sentAt: when,
        text: `nudge ${id}`,
        wamid,
        topicBucket: "mood",
        topicHint: "how are you feeling",
    });

    // --- streak counting
    const all = [nudge("c", at("19:05"), "w3"), nudge("a", at("10:39"), "w1"), nudge("b", at("16:00"), "w2")];
    assert.deepEqual(s.unansweredStreak(all, null).map((x) => x.nudgeId), ["a", "b", "c"]);
    ok("no elder message ever → every nudge is unanswered, oldest first");
    assert.deepEqual(s.unansweredStreak(all, at("12:00")).map((x) => x.nudgeId), ["b", "c"]);
    ok("elder message in between resets: only nudges after it count");
    assert.equal(s.unansweredStreak(all, at("20:00")).length, 0);
    ok("elder replied after the last nudge → streak 0");

    // --- follow-up planning
    assert.deepEqual(s.planNextNudge([], at("10:39")), { mode: "fresh" });
    ok("no unanswered nudge → fresh nudge");
    const st1 = s.unansweredStreak([all[1]!], null);
    const p1 = s.planNextNudge(st1, at("16:00"), { followupMinGapMs: 3 * H, alertCount: 3 });
    assert.equal(p1.mode, "followup");
    assert.equal(p1.mode === "followup" && p1.replyTo, "w1");
    assert.equal(p1.mode === "followup" && p1.unansweredCount, 1);
    ok("previous unanswered → follow-up quoting its wamid");
    assert.deepEqual(s.planNextNudge(st1, at("12:00"), { followupMinGapMs: 3 * H }), {
        mode: "skip",
        reason: "followup_too_soon",
    });
    ok("follow-up waits ≥ min gap (3h default) after the unanswered nudge");
    const st3 = s.unansweredStreak(all, null);
    assert.equal(s.planNextNudge(st3, at("21:30"), { followupMinGapMs: 1 * H, alertCount: 3 }).mode, "skip");
    assert.equal(s.planNextNudge(st3, at("10:30", 27), { followupMinGapMs: 1 * H, alertCount: 3 }).mode, "followup");
    ok("past the alert threshold: at most one follow-up per IST day");

    // --- alert-once rule
    const opts = { alertCount: 3, graceMs: 60 * M, longGapMs: 24 * H };
    assert.equal(s.silenceAlertDecision(st3.slice(0, 2), at("19:00"), null, opts).alert, false);
    ok("2 unanswered (same day) → no alert");
    const graceD = s.silenceAlertDecision(st3, at("19:30"), null, opts);
    assert.equal(graceD.alert, false);
    assert.equal(graceD.reason, "grace");
    ok("3rd nudge only counts as unanswered after the grace period");
    const d = s.silenceAlertDecision(st3, at("20:10"), null, opts);
    assert.equal(d.alert, true);
    assert.equal(d.reason, "count");
    assert.equal(d.key, "a");
    assert.equal(d.unanswered, 3);
    ok("3rd unanswered + grace → alert, keyed to the streak's first nudge");
    assert.equal(s.silenceAlertDecision(st3, at("21:00"), "a", opts).reason, "already_alerted");
    const four = s.unansweredStreak([...all, nudge("d", at("10:30", 27), "w4")], null);
    assert.equal(s.silenceAlertDecision(four, at("12:00", 27), "a", opts).alert, false);
    ok("same streak (even with a 4th nudge) never alerts twice");
    const fresh = s.unansweredStreak(
        [nudge("e", at("10:30", 28)), nudge("f", at("16:00", 28)), nudge("g", at("19:00", 28))],
        at("09:00", 28),
    );
    assert.equal(s.silenceAlertDecision(fresh, at("20:30", 28), "a", opts).alert, true);
    ok("elder replied → new streak → can alert again");
    const longGap = s.unansweredStreak([nudge("x", at("10:30", 25)), nudge("y", at("10:30", 26))], null);
    assert.equal(s.silenceAlertDecision(longGap, at("12:00", 26), null, opts).reason, "long_gap");
    ok("very long gap: 2 unanswered across ≥24h escalates sooner");

    // --- alert copy
    const msg = s.formatSilenceAlert({
        elderName: "Maa",
        lastReplyAt: at("20:15", 25),
        unanswered: 3,
        firstUnansweredAt: at("10:39"),
        now: at("20:10"),
    });
    assert.match(msg, /Maa hasn't replied to Saheli's last 3 check-ins \(since today, 10:39 AM\)/);
    assert.match(msg, /Last reply: yesterday, 8:15 PM/);
    ok(`alert copy: ${JSON.stringify(msg)}`);

    // --- reply-context threading on the wire
    bodies.length = 0;
    const long = `${"a".repeat(4000)}\n\n${"b".repeat(300)}`;
    const ids = await client.sendViaMetaWhatsApp("+919000000001", long, undefined, { contextMessageId: "wamid.PREV" });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0]!.context, { message_id: "wamid.PREV" });
    assert.equal(bodies[1]!.context, undefined);
    assert.equal(ids.length, 2);
    ok("follow-up quotes the previous wamid on the first part only; wamids returned");
    bodies.length = 0;
    const ids2 = await client.sendViaMetaWhatsApp("+919000000001", "hi", [{ type: "text", text: { body: "Pranam!" } }], {
        contextMessageId: "wamid.PREV2",
    });
    assert.deepEqual(bodies[0]!.context, { message_id: "wamid.PREV2" });
    assert.equal(ids2.length, 1);
    bodies.length = 0;
    await client.sendViaMetaWhatsApp("+919000000001", "plain");
    assert.equal(bodies[0]!.context, undefined);
    ok("payload path threads too; ordinary sends carry no context");

    console.log(`\n${passed} checks passed`);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
