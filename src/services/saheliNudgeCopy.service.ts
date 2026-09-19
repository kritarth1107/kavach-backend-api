import type { SaheliNudgeKind } from "../models/saheliNudgeLog.model";

function isHindiFamily(lang: string): boolean {
    const l = lang.toLowerCase();
    return l === "hindi" || l === "hinglish";
}

export function buildCareNudgeText(input: {
    nudgeKind: SaheliNudgeKind;
    title: string;
    time: string;
    displayName: string;
    preferredLanguage?: string;
}): string {
    const hindi = isHindiFamily(input.preferredLanguage ?? "english");

    if (input.nudgeKind === "pre_reminder") {
        return hindi
            ? `Yaad dilana: ${input.title} ${input.time} baje hai — thodi der mein.`
            : `Reminder: ${input.title} at ${input.time} is coming up soon.`;
    }
    if (input.nudgeKind === "missed_followup") {
        return hindi
            ? `Bas check kar rahi hoon — ${input.title} (${input.time}) ho gaya kya?`
            : `Just checking — did you get a chance to do ${input.title} (${input.time})?`;
    }
    if (input.nudgeKind === "completion_praise") {
        return hindi
            ? `Bahut accha — aaj ${input.title} complete kar liya.`
            : `Well done on completing ${input.title} today.`;
    }
    if (input.nudgeKind === "appointment_prep") {
        return hindi
            ? `${input.title} ${input.time} baje hai — documents/taxi ready rakhein?`
            : `${input.title} at ${input.time} is coming up — need help getting ready?`;
    }
    return `Reminder: ${input.title} at ${input.time}.`;
}
