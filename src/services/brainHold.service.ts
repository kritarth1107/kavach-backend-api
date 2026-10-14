/**
 * When Saheli's brain cannot answer a WhatsApp message (the engine returns 503 from /v2/turn, times out or cannot be
 * reached), the old brain (v1) is never used any more (trust plan A1, C5; founder D9) and the person is never left in
 * silence:
 *  1. at once, one short holding line in their language ("One moment, I'll reply shortly"), written ahead for every
 *     language Saheli speaks: no model call;
 *  2. the turn is saved and tried again every 30 s for up to 10 minutes; when the brain answers, the answer goes out as
 *     a normal reply (the engine knows the message id, so a turn it finished meanwhile is not done twice);
 *  3. still failing after 10 minutes: the Kavach team gets an email (alertOps) and the person hears "I'm having
 *     trouble; your message is saved, I'll reply soon". The saved turn is still tried every 5 minutes for 3 hours, so
 *     that promise is kept; after that the team is told it was given up.
 * A newer message from the same person carries the waiting ones with it to the brain, so answers never come out of order.
 */
import BrainRetryTurn, { type IBrainRetryTurn } from "../models/brainRetryTurn.model";
import { dialectBase, languageInfo, type SpeechProfile } from "./language.service";

export const RETRY_EVERY_MS = 30_000;
export const RETRY_WINDOW_MS = 10 * 60_000;
export const SLOW_EVERY_MS = 5 * 60_000;
export const GIVE_UP_AFTER_MS = 3 * 60 * 60_000;
const LOCK_MS = 150_000;

type Lines = { holding: string; trouble: string };

/** Written ahead, one pair per language (Saheli speaks as a woman). Roman letters only where asked for (Hindi). */
export const HOLD_LINES: Record<string, Lines> = {
    en: { holding: "One moment, I'll reply shortly 🙏", trouble: "I'm having some trouble right now. Your message is saved, and I'll reply soon 🙏" },
    hi: { holding: "एक मिनट, मैं अभी जवाब देती हूँ 🙏", trouble: "अभी मुझे थोड़ी दिक्कत हो रही है। आपका संदेश सेव है, मैं जल्दी जवाब दूँगी 🙏" },
    "hi-roman": { holding: "Ek minute, main abhi jawab deti hoon 🙏", trouble: "Abhi mujhe thodi dikkat ho rahi hai. Aapka message save hai, main jaldi jawab doongi 🙏" },
    bn: { holding: "এক মিনিট, আমি এখনই উত্তর দিচ্ছি 🙏", trouble: "এখন আমার একটু সমস্যা হচ্ছে। আপনার মেসেজ রাখা আছে, আমি শিগগিরই উত্তর দেব 🙏" },
    mr: { holding: "एक मिनिट, मी लगेच उत्तर देते 🙏", trouble: "आत्ता मला थोडी अडचण येत आहे. तुमचा संदेश जतन केला आहे, मी लवकरच उत्तर देईन 🙏" },
    ta: { holding: "ஒரு நிமிடம், நான் இப்போதே பதில் சொல்கிறேன் 🙏", trouble: "இப்போது எனக்கு கொஞ்சம் சிக்கல். உங்கள் செய்தி சேமிக்கப்பட்டுள்ளது, விரைவில் பதில் சொல்கிறேன் 🙏" },
    te: { holding: "ఒక్క నిమిషం, నేను ఇప్పుడే జవాబు ఇస్తాను 🙏", trouble: "ఇప్పుడు నాకు కొంచెం ఇబ్బందిగా ఉంది. మీ సందేశం భద్రంగా ఉంది, త్వరలోనే జవాబు ఇస్తాను 🙏" },
    gu: { holding: "એક મિનિટ, હું હમણાં જ જવાબ આપું છું 🙏", trouble: "અત્યારે મને થોડી તકલીફ છે. તમારો સંદેશ સાચવી રાખ્યો છે, હું જલદી જવાબ આપીશ 🙏" },
    kn: { holding: "ಒಂದು ನಿಮಿಷ, ನಾನು ಈಗಲೇ ಉತ್ತರಿಸುತ್ತೇನೆ 🙏", trouble: "ಈಗ ನನಗೆ ಸ್ವಲ್ಪ ತೊಂದರೆ ಆಗುತ್ತಿದೆ. ನಿಮ್ಮ ಸಂದೇಶ ಉಳಿಸಲಾಗಿದೆ, ಬೇಗನೆ ಉತ್ತರಿಸುತ್ತೇನೆ 🙏" },
    ml: { holding: "ഒരു നിമിഷം, ഞാൻ ഇപ്പോൾ തന്നെ മറുപടി തരാം 🙏", trouble: "ഇപ്പോൾ എനിക്ക് ചെറിയൊരു പ്രശ്നമുണ്ട്. നിങ്ങളുടെ സന്ദേശം സൂക്ഷിച്ചിട്ടുണ്ട്, ഉടൻ മറുപടി തരാം 🙏" },
    pa: { holding: "ਇੱਕ ਮਿੰਟ, ਮੈਂ ਹੁਣੇ ਜਵਾਬ ਦਿੰਦੀ ਹਾਂ 🙏", trouble: "ਹੁਣ ਮੈਨੂੰ ਥੋੜ੍ਹੀ ਮੁਸ਼ਕਲ ਆ ਰਹੀ ਹੈ। ਤੁਹਾਡਾ ਸੁਨੇਹਾ ਸੰਭਾਲ ਲਿਆ ਹੈ, ਮੈਂ ਜਲਦੀ ਜਵਾਬ ਦਿਆਂਗੀ 🙏" },
    or: { holding: "ଗୋଟିଏ ମିନିଟ୍, ମୁଁ ଏବେ ଉତ୍ତର ଦେଉଛି 🙏", trouble: "ଏବେ ମୋର ଟିକେ ଅସୁବିଧା ହେଉଛି। ଆପଣଙ୍କ ମେସେଜ୍ ସେଭ୍ ଅଛି, ମୁଁ ଶୀଘ୍ର ଉତ୍ତର ଦେବି 🙏" },
    as: { holding: "এক মিনিট, মই এতিয়াই উত্তৰ দিছোঁ 🙏", trouble: "এতিয়া মোৰ অলপ অসুবিধা হৈছে। আপোনাৰ বাৰ্তা সংৰক্ষিত আছে, মই সোনকালে উত্তৰ দিম 🙏" },
    ur: { holding: "ایک منٹ، میں ابھی جواب دیتی ہوں 🙏", trouble: "ابھی مجھے تھوڑی دقت ہو رہی ہے۔ آپ کا پیغام محفوظ ہے، میں جلد جواب دوں گی 🙏" },
    ne: { holding: "एक मिनेट, म अहिले नै जवाफ दिन्छु 🙏", trouble: "अहिले मलाई अलिकति समस्या भइरहेको छ। तपाईंको सन्देश सुरक्षित छ, म छिट्टै जवाफ दिन्छु 🙏" },
    kok: { holding: "एक मिनीट, हांव आतांच जाप दितां 🙏", trouble: "आतां म्हाका थोडो त्रास जाता. तुमचो संदेश सांबाळून दवरला, हांव बेगीनच जाप दितलें 🙏" },
};

/** The pair for this person's saved language (a dialect speaks its base language; unknown → English). */
export function holdLines(speech: SpeechProfile | null | undefined): Lines {
    const base = dialectBase(speech?.dialect) || languageInfo(speech?.language)?.code || "en";
    if (base === "hi" && speech?.script === "roman") return HOLD_LINES["hi-roman"];
    return HOLD_LINES[base] ?? HOLD_LINES.en;
}

/** Their language: the care record first (engine, cached 60 s), then the backend's copy. */
export async function speechFor(familyId: string, userId: string): Promise<SpeechProfile> {
    const { getEnginePerson } = await import("../clients/enginePerson.client");
    const p = await getEnginePerson(familyId, userId).catch(() => null);
    if (p?.language) return { language: p.language, dialect: p.dialect ?? undefined, script: p.script ?? undefined };
    const { getSpeechProfile } = await import("./voicePreference.service");
    return getSpeechProfile(userId).catch(() => ({}));
}

export type HeldTurn = {
    familyId: string;
    userId: string;
    role: string;
    phone: string;
    messageRef?: string;
    text: string;
    button?: boolean;
    voice?: { confidence?: number; language?: string; engine?: string };
    wasVoice?: boolean;
    hadMedia?: boolean;
    mediaNote?: string;
    location?: { lat: number; lng: number; name?: string; address?: string };
};

/** Save a turn the brain could not answer and return the holding line to send now. */
export async function holdTurn(turn: HeldTurn, now = new Date()): Promise<string> {
    const ref = turn.messageRef || `held:${turn.userId}:${now.getTime()}`;
    const mediaNote = turn.hadMedia
        ? [turn.mediaNote, "They also sent a photo, video or file with this message; it could not be kept while you were away: ask them to send it again if it matters."].filter(Boolean).join(" ")
        : turn.mediaNote ?? null;
    await BrainRetryTurn.updateOne(
        { messageRef: ref },
        {
            $setOnInsert: {
                familyId: turn.familyId, userId: turn.userId, role: turn.role, phone: turn.phone, messageRef: ref, text: turn.text,
                button: Boolean(turn.button), voice: turn.voice ?? null, wasVoice: Boolean(turn.wasVoice), mediaNote,
                location: turn.location ?? null, status: "queued", attempts: 1, nextAt: new Date(now.getTime() + RETRY_EVERY_MS),
                firstFailedAt: now,
            },
        },
        { upsert: true },
    );
    console.warn(`[brain-hold] turn held family=${turn.familyId} ref=${ref.slice(0, 24)}`);
    void import("./opsAlert.service").then(({ alertOps }) =>
        alertOps("brain-hold", "Saheli's brain could not answer: holding line sent",
            `A WhatsApp turn got the holding line because the brain (engine /v2/turn) did not answer. It is retried every 30 s for 10 minutes. family=${turn.familyId.slice(0, 8)}`),
    ).catch(() => undefined);
    return holdLines(await speechFor(turn.familyId, turn.userId)).holding;
}

/**
 * Messages from this person still waiting for an answer: they go to the brain with the new one (marked merged), oldest
 * first, so the person gets one answer in order. Returns the text to send instead of `text`.
 */
export async function withWaitingTurns(userId: string, text: string, now = new Date()): Promise<{ text: string; merged: string[] }> {
    // A turn the retry tick is trying right now (locked) is left to it, so it is never answered twice.
    const free = { status: "queued", $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] };
    const rows = await BrainRetryTurn.find({ userId, ...free }).sort({ createdAt: 1 }).limit(5).lean<IBrainRetryTurn[]>().catch(() => []);
    if (!rows.length) return { text, merged: [] };
    const refs = rows.map((r) => r.messageRef);
    await BrainRetryTurn.updateMany({ messageRef: { $in: refs }, ...free }, { $set: { status: "merged", answeredAt: now } }).catch(() => undefined);
    const earlier = rows
        .filter((r) => r.text?.trim())
        .map((r) => `(An earlier message of theirs you could not answer yet, sent ${istTime(r.firstFailedAt)}: ${r.text.trim()})`);
    return { text: [...earlier, text].join("\n"), merged: refs };
}

function istTime(d: Date | string | undefined): string {
    if (!d) return "earlier";
    return new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
}

export type RetryDeps = {
    /** Run the brain for a held turn (brainV2.runBrainV2); null or a throw is a failure. */
    brain: (row: IBrainRetryTurn) => Promise<{ reply: string; messages?: string[]; buttons?: Array<{ id: string; title: string }>; location_request?: boolean } | null>;
    /** Send a reply on WhatsApp. `messages` are separate bubbles, the answer first. */
    send: (row: IBrainRetryTurn, text: string, extra?: { buttons?: Array<{ id: string; title: string }>; location_request?: boolean; messages?: string[] }) => Promise<void>;
    alert: (key: string, subject: string, text: string) => Promise<unknown>;
    lines: (row: IBrainRetryTurn) => Promise<Lines>;
};

async function defaultBrain(row: IBrainRetryTurn) {
    const V2 = await import("./brainV2.service");
    return V2.runBrainV2({
        identity: { familyId: row.familyId, userId: row.userId, role: row.role },
        text: row.text,
        messageRef: row.messageRef,
        mode: "live",
        voice: row.voice ?? undefined,
        mediaNote: row.mediaNote ?? undefined,
        location: row.location ?? undefined,
    });
}

async function defaultSend(row: IBrainRetryTurn, text: string, extra: { buttons?: Array<{ id: string; title: string }>; location_request?: boolean; messages?: string[] } = {}) {
    const R = await import("./whatsappRouting.service");
    const context = extra.location_request
        ? { kind: "location_request" as const }
        : extra.buttons?.length ? { kind: "saheli_buttons" as const, buttons: extra.buttons } : {};
    const bubbles = (extra.messages ?? []).map((s) => s.trim()).filter((s) => s && s !== "none");
    let out = bubbles.length > 1 ? R.messagesOutbound(row.phone, bubbles, context) : R.buildWhatsAppOutbound(row.phone, text, context);
    const { getVoiceMode, wantsVoice } = await import("./voicePreference.service");
    if (wantsVoice(await getVoiceMode(row.userId, row.familyId), Boolean(row.wasVoice))) out = R.withVoiceReply(out, row.userId);
    const meta = await import("../clients/metaWhatsApp.client");
    if (!meta.isMetaWhatsAppEnabled()) {
        console.log(`[brain-hold] (WhatsApp off) would send to ${row.phone.slice(0, 6)}…`);
        return;
    }
    const { sendWhatsAppReply } = await import("./voiceAfterText.service");
    await sendWhatsAppReply(out);
}

const DEFAULT_DEPS: RetryDeps = {
    brain: defaultBrain,
    send: defaultSend,
    alert: async (key, subject, text) => (await import("./opsAlert.service")).alertOps(key, subject, text, { everyMs: 10 * 60_000 }),
    lines: async (row) => holdLines(await speechFor(row.familyId, row.userId)),
};

/** One pass of the retry queue (every 30 s): every held turn that is due is tried once. */
export async function runBrainRetryTick(now = new Date(), deps: RetryDeps = DEFAULT_DEPS): Promise<{ tried: number; answered: number; trouble: number; gaveUp: number }> {
    const out = { tried: 0, answered: 0, trouble: 0, gaveUp: 0 };
    for (let i = 0; i < 20; i++) {
        const row = await BrainRetryTurn.findOneAndUpdate(
            { status: "queued", nextAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
            { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
            { sort: { nextAt: 1 }, new: true },
        ).lean<IBrainRetryTurn | null>();
        if (!row) break;
        out.tried += 1;
        let answer: Awaited<ReturnType<RetryDeps["brain"]>> = null;
        let error = "";
        try {
            answer = await deps.brain(row);
        } catch (err) {
            error = err instanceof Error ? err.message.slice(0, 200) : "failed";
        }
        const bubbles = (await import("./brainV2.service")).replyMessages(answer);
        if (bubbles.length) {
            await deps.send(row, bubbles[0]!, { buttons: answer?.buttons, location_request: answer?.location_request, messages: bubbles }).catch((err) =>
                console.error(`[brain-hold] answer send failed: ${err instanceof Error ? err.message : err}`));
            await BrainRetryTurn.updateOne({ messageRef: row.messageRef }, { $set: { status: "answered", answeredAt: now, lockedUntil: null } });
            console.log(`[brain-hold] held turn answered after ${row.attempts} tries family=${row.familyId}`);
            out.answered += 1;
            continue;
        }
        if (answer && (!answer.reply?.trim() || answer.reply.trim() === "none")) {
            // The brain ran and chose not to reply (a turn it had already answered): nothing more to do.
            await BrainRetryTurn.updateOne({ messageRef: row.messageRef }, { $set: { status: "answered", answeredAt: now, lockedUntil: null } });
            out.answered += 1;
            continue;
        }
        const age = now.getTime() - new Date(row.firstFailedAt).getTime();
        const set: Record<string, unknown> = { attempts: row.attempts + 1, lastError: error || "no reply", lockedUntil: null };
        if (age >= GIVE_UP_AFTER_MS) {
            set.status = "gave_up";
            await deps.alert("brain-hold-gave-up", "A held WhatsApp message was never answered",
                `Saheli's brain did not answer a saved message for 3 hours; the person was told it was saved. family=${row.familyId.slice(0, 8)} ref=${row.messageRef.slice(0, 24)} tries=${row.attempts + 1}. Answer them by hand.`);
            out.gaveUp += 1;
        } else if (age >= RETRY_WINDOW_MS && !row.troubleSentAt) {
            set.troubleSentAt = now;
            set.nextAt = new Date(now.getTime() + SLOW_EVERY_MS);
            const lines = await deps.lines(row);
            await deps.send(row, lines.trouble).catch((err) => console.error(`[brain-hold] trouble line failed: ${err instanceof Error ? err.message : err}`));
            await deps.alert("brain-hold-10min", "Saheli could not answer a WhatsApp message for 10 minutes",
                `The brain (engine /v2/turn) failed every 30 s for 10 minutes. The person got "your message is saved, I'll reply soon"; it is tried every 5 minutes for 3 hours. family=${row.familyId.slice(0, 8)} last error: ${error || "no reply"}`);
            out.trouble += 1;
        } else {
            set.nextAt = new Date(now.getTime() + (row.troubleSentAt ? SLOW_EVERY_MS : RETRY_EVERY_MS));
        }
        await BrainRetryTurn.updateOne({ messageRef: row.messageRef }, { $set: set });
    }
    return out;
}
