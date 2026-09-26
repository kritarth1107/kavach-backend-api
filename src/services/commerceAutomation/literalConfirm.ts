/**
 * Sign-in / OTP guardrail: a store login (browser, remote browser, pharmacy site) only starts
 * after the elder types the literal word "confirm" on the product card — the same rule as
 * placing an order. "yes"/"haan"/"ok", a repeated ask ("doodh mangwa do") or a router
 * confirm-with-confidence never start one.
 */
export function isLiteralConfirm(text: string | null | undefined): boolean {
    return /^\s*\*?confirm\*?\s*(order)?\s*[.!]*\s*$/i.test(String(text || ""));
}

/** Soft yes that must NOT start a sign-in (answered with "reply *confirm*"). */
export function isSoftYes(text: string | null | undefined): boolean {
    return /^\s*(yes|y|haan|han|ha|ok|okay|theek\s*hai|thik\s*hai|place|kar\s*do|order\s*karo|ji|done|sure|go\s*ahead)\s*[.!]*\s*$/i.test(String(text || ""));
}

export function signInConfirmNudge(storeLabel: string): string {
    return `To go ahead, reply *confirm* — I'll then open *${storeLabel}* and ask you for the login OTP. Or *cancel*.`;
}
