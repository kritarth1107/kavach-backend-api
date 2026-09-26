import type { SaheliNudgeKind } from "../models/saheliNudgeLog.model";

function isHindiFamily(lang: string): boolean {
    const l = lang.toLowerCase();
    return l === "hindi" || l === "hinglish";
}

/**
 * Saheli's care nudges — written like her own child would say it: warm, respectful ("aap"),
 * short, never nagging. `addressAs` is what she likes to be called (learned / caregiver-set).
 */
export function buildCareNudgeText(input: {
    nudgeKind: SaheliNudgeKind;
    title: string;
    time: string;
    displayName: string;
    preferredLanguage?: string;
    addressAs?: string;
}): string {
    const hindi = isHindiFamily(input.preferredLanguage ?? "english");
    const who = input.addressAs?.trim() || input.displayName;

    if (input.nudgeKind === "pre_reminder") {
        return hindi
            ? `${who}, thodi der mein ${input.title} ka time ho jayega (${input.time}) 🙂`
            : `${who}, ${input.title} is coming up at ${input.time} 🙂`;
    }
    if (input.nudgeKind === "missed_followup") {
        return hindi
            ? `${who}, bas pooch rahi thi — ${input.title} (${input.time}) ho gaya? Nahi hua to koi baat nahi, abhi kar lijiye 🙏`
            : `${who}, just checking — did ${input.title} (${input.time}) happen? If not, no worries, whenever you can 🙏`;
    }
    if (input.nudgeKind === "completion_praise") {
        return hindi ? `Wah ${who}, aaj ${input.title} ho gaya — bahut accha kiya 💛` : `Lovely, ${who} — ${input.title} done today 💛`;
    }
    if (input.nudgeKind === "appointment_prep") {
        return hindi
            ? `${who}, ${input.title} ${input.time} baje hai. Kaagaz ya gaadi ka intezaam karna ho to bata dijiye, main madad kar dungi.`
            : `${who}, ${input.title} is at ${input.time}. If you'd like help with papers or a ride, just tell me.`;
    }
    if (input.nudgeKind === "daily_schedule") {
        return hindi
            ? `Suprabhat ${who} 🌸 Aaj ka din aise hai:\n${input.title}`
            : `Good morning, ${who} 🌸 Here's your day:\n${input.title}`;
    }
    return hindi ? `${who}, ${input.title} ${input.time} baje yaad se 🙂` : `${who}, a gentle reminder: ${input.title} at ${input.time}.`;
}
