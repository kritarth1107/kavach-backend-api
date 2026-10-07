/** Personal details are masked by default in every admin response; revealing needs pii.reveal and a reason. */

export function maskPhone(phone?: string | null): string | null {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 6) return "•".repeat(digits.length);
    const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : "";
    return `${cc}••••• •${digits.slice(-4)}`;
}

export function maskEmail(email?: string | null): string | null {
    if (!email) return null;
    const [user, domain] = String(email).split("@");
    if (!domain) return "•••";
    const head = user.slice(0, 1);
    const tail = user.length > 2 ? user.slice(-1) : "";
    return `${head}${"•".repeat(Math.max(2, Math.min(user.length - head.length - tail.length, 6)))}${tail}@${domain}`;
}

/** "Vasundara Devi" → "Vasundara D." (first name is how support talks about a person). */
export function maskName(name?: string | null): string | null {
    if (!name) return null;
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] ?? null;
    return `${parts[0]} ${parts.slice(1).map((p) => `${p[0].toUpperCase()}.`).join(" ")}`;
}
