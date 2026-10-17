/**
 * Saheli Brain v2 (ai-engine /v2/turn): one brain that reads the raw message with the family's
 * care memory and decides. BRAIN_V2=off|shadow|live. In shadow it runs beside the current path on
 * real traffic with separate memory and no side effects; BRAIN_V2_LIVE_FAMILIES switches named
 * families to it (with the current path as fallback if v2 fails).
 */
import { FamilyRole } from "../types/family.types";
import { flaggedEnv } from "./featureFlags.service";

export type BrainMode = "off" | "shadow" | "live";

/** Env BRAIN_V2 / BRAIN_V2_LIVE_FAMILIES, overridden by the admin console's flags when set. */
export function brainV2Mode(familyId: string, env: NodeJS.ProcessEnv = flaggedEnv()): BrainMode {
    const live = (env.BRAIN_V2_LIVE_FAMILIES || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (live.includes(familyId)) return "live";
    const mode = (env.BRAIN_V2 || "off").trim().toLowerCase();
    return mode === "shadow" || mode === "live" ? (mode as BrainMode) : "off";
}

type Identity = { familyId: string; userId: string; role: FamilyRole | string };

/** WhatsApp bubbles for one brain turn: the answer first, then anything else (a change, a waiting brief). An older
 *  engine that only returns `reply` still sends that one message. */
export function replyMessages(out: { reply?: string; messages?: unknown } | null | undefined): string[] {
    const raw = out && Array.isArray(out.messages) ? out.messages : [];
    const list = raw.map((s) => String(s ?? "").trim()).filter((s) => s && s !== "none");
    if (list.length) return list;
    const reply = String(out?.reply ?? "").trim();
    return reply && reply !== "none" ? [reply] : [];
}

export function brainRole(role: string): string {
    if (role === FamilyRole.CARE_RECIPIENT) return "elder";
    if (role === FamilyRole.PRIMARY_CAREGIVER) return "primary caregiver";
    if (role === FamilyRole.CO_CAREGIVER) return "caregiver";
    if (role === FamilyRole.FAMILY_DOCTOR) return "family doctor";
    return "family member";
}

type BrainMember = { userId: string; name?: string; role: string; status?: string; relationship?: string; invitedBy?: string };

/** A member as the brain sees them. The relationship the family gave when adding someone is to the member who added
 *  them ("mother" of the caregiver): without it Saheli guessed, and called a patient's husband her son. */
export function brainPerson(m: BrainMember): { id: string; name: string; role: string; relation?: string; relation_to?: string } {
    const relation = (m.relationship || "").trim();
    return {
        id: m.userId,
        name: (m.name || "").trim(),
        role: brainRole(m.role),
        ...(relation && m.invitedBy && m.invitedBy !== m.userId ? { relation: relation.slice(0, 40), relation_to: m.invitedBy } : {}),
    };
}

export async function runBrainV2(input: {
    identity: Identity;
    text: string;
    messageRef?: string;
    mode: Exclude<BrainMode, "off">;
    /** The message was a voice note: `text` is its transcript (confidence 0..1 when the speech engine reported one). */
    voice?: { confidence?: number; language?: string; engine?: string };
    /** A photo, video, PDF or sticker they sent (base64), for the brain to look at; mediaNote when it could not be opened. */
    media?: Array<{ mime: string; data: string }>;
    mediaNote?: string;
    /** A shared location pin (a ride's pickup): passed as data. */
    location?: { lat: number; lng: number; name?: string; address?: string };
    /** The WhatsApp message id this message quotes: Saheli gets back what an earlier photo showed (live 17 Oct). */
    replyTo?: string;
}): Promise<{ reply: string; actions: unknown[]; alerts: unknown[]; model: string; buttons?: Array<{ id: string; title: string }>;
    location_request?: boolean; duplicate?: boolean } | null> {
    const { getFamilyMembersList } = await import("./familyMember.service");
    const { members } = await getFamilyMembersList(input.identity.familyId, input.identity.userId);
    const joined = (members as BrainMember[]).filter(
        (m) => m.userId && m.status !== "REMOVED" && m.status !== "REJECTED",
    );
    const elder =
        joined.find((m) => m.userId === input.identity.userId && m.role === FamilyRole.CARE_RECIPIENT) ||
        joined.find((m) => m.role === FamilyRole.CARE_RECIPIENT) ||
        // Self care: a family with no one to care for yet still gets the brain, about the caregiver themselves.
        joined.find(
            (m) =>
                m.userId === input.identity.userId &&
                (m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER),
        ) ||
        // Anyone else in a family with no one cared for yet: the brain about the speaker (v1 used to answer them; a held
        // turn could never be answered and would only be retried for 3 hours).
        joined.find((m) => m.userId === input.identity.userId);
    if (!elder) return null;
    const speaker = joined.find((m) => m.userId === input.identity.userId);
    const person = brainPerson;
    // Reminders due soon for the speaker (and the person cared for): Saheli skips one the person says is already done.
    const soon = await import("./saheliReminder.service")
        .then((R) => R.remindersSoon(input.identity.familyId, [input.identity.userId, elder.userId]))
        .catch(() => []);
    // Messages that could not reach them while their WhatsApp chat was closed (they got a template): the webhook already
    // gave them word for word (B3.4; Saheli is told, and never repeats them); anything still left, Saheli gives now.
    const given = (await import("./deliveryLedger.service").then((L) => L.currentDelivery()?.given).catch(() => undefined)) ?? [];
    const left = await import("./whatsappWindow.service")
        .then((W) => W.takeWaiting(input.identity.userId))
        .catch(() => []);
    const waiting = [...given.slice(-8).map((w) => ({ ...w, delivered: true })), ...left].slice(-8);
    const { aiPostBrainTurn } = await import("../clients/aiEngine.client");
    const started = Date.now();
    const out = await aiPostBrainTurn({
        family_id: input.identity.familyId,
        elder: person(elder),
        speaker: speaker ? person(speaker) : { id: input.identity.userId, name: "", role: brainRole(String(input.identity.role)) },
        members: joined.map(person),
        text: input.text,
        message_ref: input.messageRef,
        channel: "whatsapp",
        mode: input.mode,
        ...(input.voice
            ? { modality: "voice", voice_confidence: input.voice.confidence ?? null, voice_language: input.voice.language ?? null }
            : {}),
        ...(input.media?.length ? { images: input.media } : {}),
        ...(input.mediaNote ? { media_note: input.mediaNote } : {}),
        ...(input.location ? { location: { name: "", address: "", ...input.location } } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo.slice(0, 160) } : {}),
        ...(waiting.length ? { waiting } : {}),
        ...(soon.length
            ? {
                  reminders_soon: soon.map((r) => ({
                      id: r.reminderId, person: r.recipientUserId, text: r.text, day: r.day, time: r.time, repeat: r.repeat,
                      item: r.aboutKey,
                  })),
              }
            : {}),
    });
    const ms = Date.now() - started;
    if (input.mode === "live") {
        const { note } = await import("../obs/emf");
        note("Kavach/Reply", "turn", { calls: 1, latencyMs: ms });
    }
    console.log(
        `[brain-v2] ${JSON.stringify({
            mode: input.mode,
            family: input.identity.familyId,
            speaker: brainRole(String(input.identity.role)),
            ms,
            model: out.model,
            text: input.text.slice(0, 300),
            reply: out.reply.slice(0, 500),
            actions: (out.actions as Array<{ tool: string; ok: boolean }>).map((a) => `${a.tool}${a.ok ? "" : "!"}`),
            wouldHave: out.shadow_writes?.map((w: { tool: string }) => w.tool),
        })}`,
    );
    return out;
}
