/**
 * The Kavach care team is told at once (founder 2026-10-13: "if any of our users is talking [of suicide], inform us via
 * email kritarth@kavach.care; any user, alert us immediately"). Two kinds:
 *   crisis           talk of suicide, self-harm, wanting to die or harming someone, even if it may be a joke or a test
 *                    (a later "just kidding" never cancels it: the team decides);
 *   emergency_alone  a medical emergency or red flag with no one else in the family to tell (a self-care user); since
 *                    17 Oct 2026 (founder: only the crisis alert emails) it is kept in the activity log, not emailed.
 * The engine decides when to call (the first alert of an episode at once, later ones batched); this builds and sends the
 * email: who (name and number, so someone can call), what they said, what Saheli said and did, and a link to the family in
 * the admin console. Every send is in the family's activity log.
 */
import Family from "../models/family.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

type Line = { at?: string; said?: string; summary?: string; reply?: string };

function ist(at?: string): string {
    const d = at ? new Date(at) : new Date();
    if (Number.isNaN(d.getTime())) return String(at ?? "");
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function clip(s: unknown, n: number): string {
    return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

export async function alertCareTeam(input: {
    familyId: string;
    subjectUserId: string;
    kind: "crisis" | "emergency_alone";
    lines: Line[];
    /** Family members (other than the person) Saheli told on WhatsApp. */
    familyTold?: number;
    /** A later alert in the same episode (the first one already went). */
    update?: boolean;
    traceId?: string;
}): Promise<{ sent: boolean; to?: number; error?: string }> {
    const family = await Family.findOne({ familyId: input.familyId, status: "ACTIVE" }).lean();
    const member = family?.members.find((m) => m.userId === input.subjectUserId);
    const user = await User.findOne({ userId: input.subjectUserId }).lean<{
        firstName?: string; lastName?: string; email?: string; phone?: { countryCode?: string; number?: string };
    }>();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "A Kavach user";
    const phone = user?.phone?.countryCode && user.phone.number && !String(user.phone.countryCode).startsWith("+99")
        ? `${user.phone.countryCode} ${user.phone.number}` : "no phone saved";
    const others = (family?.members ?? []).filter((m) => m.userId !== input.subjectUserId && m.status === FamilyMemberStatus.JOINED
        && (m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER));
    const otherUsers = others.length
        ? await User.find({ userId: { $in: others.map((m) => m.userId) } }).select("firstName lastName").lean<Array<{ firstName?: string; lastName?: string }>>()
        : [];
    const otherNames = otherUsers.map((u) => [u.firstName, u.lastName].filter(Boolean).join(" ") || "a caregiver");
    const selfCare = member?.role === FamilyRole.PRIMARY_CAREGIVER || member?.role === FamilyRole.CO_CAREGIVER;
    const admin = (process.env.ADMIN_APP_URL || "https://kavach-admin-bcvowb5kfq-el.a.run.app").replace(/\/$/, "");

    const what = input.kind === "crisis" ? "may be in crisis (suicide, self-harm or harming someone)" : "reported an emergency and has no one else to alert";
    const subject = `${input.update ? "Update" : "URGENT"}: ${name} ${what}`;
    const lines = (input.lines.length ? input.lines : [{}]).map((l, i) => [
        `${i + 1}. ${ist(l.at)}`,
        l.said ? `   They said: "${clip(l.said, 600)}"` : "",
        l.summary ? `   Saheli's note: ${clip(l.summary, 400)}` : "",
        l.reply ? `   Saheli replied: "${clip(l.reply, 500)}"` : "",
    ].filter(Boolean).join("\n"));
    const text = [
        `${name} ${what}.`,
        "",
        `Who: ${name}, ${phone}`,
        `Care: ${selfCare ? "caring for themselves" : "cared for by the family"}${otherNames.length ? `; caregivers: ${otherNames.join(", ")}` : "; no one else in the family"}`,
        `Family told on WhatsApp: ${input.familyTold ? `${input.familyTold} member(s)` : "no one (there is no one else to tell, or they were told already)"}`,
        `Family: ${family?.name || "-"} (${input.familyId.slice(0, 8)})`,
        "",
        input.update ? "New since the last email:" : "What happened:",
        ...lines,
        "",
        `Open the family in the admin console: ${admin}/families/${input.familyId}`,
        input.kind === "crisis"
            ? "Saheli gives Tele-MANAS 14416 (free, 24x7) and 112 for immediate danger. Please check on them yourself; a later \"I was joking\" does not cancel this alert."
            : "Please check on them yourself.",
    ].join("\n");

    let out: { sent: boolean; to?: number; error?: string; muted?: boolean };
    try {
        const { sendCareTeamAlert } = await import("./email.service");
        out = await sendCareTeamAlert(`[Kavach] ${subject}`, text, input.kind);
    } catch (err) {
        out = { sent: false, error: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
        console.error(`[care-team-alert] email failed family=${input.familyId.slice(0, 8)}: ${out.error}`);
    }
    void import("./activityLog.service")
        .then(({ logActivity }) =>
            logActivity({
                familyId: input.familyId,
                recipientUserId: input.subjectUserId,
                kind: "caregiver_alert",
                severity: "error",
                title: out.sent ? `Kavach care team emailed: ${input.kind === "crisis" ? "crisis" : "emergency, no one else to tell"}`
                    : out.muted ? "Kavach care team noted (not emailed): emergency, no one else to tell" : "Kavach care team email FAILED",
                detail: lines.join("\n"),
                data: { careTeam: true, kind: input.kind, update: Boolean(input.update), sent: out.sent, ...(input.traceId ? { traceId: input.traceId } : {}) },
            }),
        )
        .catch(() => undefined);
    return out;
}
