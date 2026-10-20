/**
 * The one check every scheduled message passes right before it goes (founder 20 Oct): did the person say or log
 * anything today that cancels it, says it is already done, postpones it or makes it wrong? The engine reads their day
 * and decides (app/care/presend.py); with nothing said today it answers without a model call. If the engine cannot be
 * reached, the message goes: a missed reminder is worse than one extra.
 * Live 20 Oct: "Skipping gym" at 19:15, then the gym reminder at 19:30 and "are you back from the gym?" at 21:15.
 */
export async function stillRight(familyId: string, recipientUserId: string, about: string): Promise<{ send: boolean; why: string }> {
    if ((process.env.PRESEND_CHECK || "on").toLowerCase() === "off") return { send: true, why: "" };
    try {
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        const out = await aiEngineJson<{ send?: boolean; why?: string }>("POST", "/v2/brain/presend", {
            family_id: familyId, subject_id: recipientUserId, about: about.slice(0, 600),
        }, 10_000);
        return { send: out?.send !== false, why: String(out?.why ?? "").slice(0, 120) };
    } catch (err) {
        console.warn(`[presend] check failed, sending: ${err instanceof Error ? err.message : err}`);
        return { send: true, why: "" };
    }
}
