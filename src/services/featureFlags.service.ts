/**
 * Feature flags set from the admin console (collection feature_flags), read every 60 s into memory so hot paths stay
 * synchronous. A flag that is set wins over its environment variable; an unset flag leaves the env value in charge.
 */
import FeatureFlag from "../models/featureFlag.model";

export type FlagDef =
    | { type: "enum"; values: readonly string[]; env?: string; label: string; help: string }
    | { type: "list"; env?: string; label: string; help: string }
    | { type: "bool"; env?: string; envOn?: string; label: string; help: string };

export const FLAG_DEFS = {
    "brain.mode": {
        type: "enum", values: ["off", "shadow", "live"], env: "BRAIN_V2", label: "Saheli v2 for everyone",
        help: "off: the old path; shadow: v2 runs beside it with no side effects; live: v2 answers.",
    },
    "brain.liveFamilies": {
        type: "list", env: "BRAIN_V2_LIVE_FAMILIES", label: "Saheli v2 live families",
        help: "Family IDs that always get v2, whatever the mode above.",
    },
    "saheli.pausedFamilies": {
        type: "list", label: "Saheli paused families",
        help: "Saheli sends nothing on her own to these families (medicine reminders, nudges, check-ins, outreach, messages to other members). Replies to people who write, and caregiver alerts, still go.",
    },
    "nudge.regular": {
        type: "enum", values: ["off", "shadow", "on"], env: "NUDGE_REGULAR", label: "Regular nudges",
        help: "Saheli's personal message after each hour of chat silence (Kavach NUdge's plan). shadow: planned and logged in the engine, nothing sent; on: sent; off: the old check-ins.",
    },
    "nudge.meals": {
        type: "enum", values: ["off", "shadow", "on"], env: "NUDGE_MEALS", label: "Meal nudges",
        help: "Regular nudges may ask what was eaten after an unlogged main meal (nutrition plan N5). shadow: written and logged in the engine, nothing sent; on: sent (only while regular nudges are on).",
    },
    "nutrition.page": {
        type: "bool", env: "NUTRITION_PAGE", envOn: "on", label: "Food & nutrition page",
        help: "On: caregivers and self-care users see the Food & nutrition page on the dashboard and can make doctor links (nutrition plan N8, N10). Off (also when unset): no menu entry, the page and new doctor links are closed; Saheli still tracks food.",
    },
    "connectors.mcpFirst": {
        type: "bool", env: "MCP_AGENT_CONNECTOR", envOn: "on", label: "Store connectors first",
        help: "Swiggy, Instamart and Zepto through their connectors first, the browser as fallback.",
    },
    "signup.inviteOnly": {
        type: "bool", env: "INVITE_ONLY", envOn: "on", label: "Invite-only sign-up",
        help: "On (also when unset): a new account needs an invite link or an approved waitlist entry; everyone else joins the waitlist, on the dashboard and on WhatsApp. Off: anyone can sign up.",
    },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAG_DEFS;
export const FLAG_KEYS = Object.keys(FLAG_DEFS) as FlagKey[];

let snapshot: Partial<Record<FlagKey, unknown>> = {};
let loadedAt = 0;
let timer: NodeJS.Timeout | null = null;

export function validFlagValue(key: FlagKey, value: unknown): boolean {
    const def: FlagDef = FLAG_DEFS[key];
    if (value === null) return true; // null = unset, env decides
    if (def.type === "enum") return typeof value === "string" && def.values.includes(value);
    if (def.type === "bool") return typeof value === "boolean";
    return Array.isArray(value) && value.length <= 500 && value.every((v) => typeof v === "string" && /^[\w-]{1,64}$/.test(v));
}

export async function refreshFlags(): Promise<void> {
    const rows = await FeatureFlag.find({ key: { $in: FLAG_KEYS } }).lean<Array<{ key: FlagKey; value: unknown }>>();
    const next: Partial<Record<FlagKey, unknown>> = {};
    for (const r of rows) if (r.value !== null && r.value !== undefined && validFlagValue(r.key, r.value)) next[r.key] = r.value;
    snapshot = next;
    loadedAt = Date.now();
}

export function startFlagRefresh(everyMs = 60_000): void {
    if (timer) return;
    void refreshFlags().catch((err) => console.warn("feature flags load failed (env values apply):", err?.message || err));
    timer = setInterval(() => void refreshFlags().catch(() => undefined), everyMs);
    timer.unref?.();
}

/** For tests. */
export function setFlagSnapshot(s: Partial<Record<FlagKey, unknown>>): void {
    snapshot = s;
    loadedAt = Date.now();
}

export function flagsLoadedAt(): number {
    return loadedAt;
}

/** The environment as the app should see it: admin-set flags override the matching variables. */
export function flaggedEnv(env: NodeJS.ProcessEnv = process.env, flags = snapshot): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...env };
    if (typeof flags["brain.mode"] === "string") out.BRAIN_V2 = flags["brain.mode"] as string;
    if (Array.isArray(flags["brain.liveFamilies"])) out.BRAIN_V2_LIVE_FAMILIES = (flags["brain.liveFamilies"] as string[]).join(",");
    if (typeof flags["connectors.mcpFirst"] === "boolean") out.MCP_AGENT_CONNECTOR = flags["connectors.mcpFirst"] ? "on" : "off";
    return out;
}

/** Meal nudges: off | shadow | on (admin flag, else NUDGE_MEALS, else off). */
export function mealNudgeMode(env: NodeJS.ProcessEnv = process.env, flags = snapshot): "off" | "shadow" | "on" {
    const v = typeof flags["nudge.meals"] === "string" ? (flags["nudge.meals"] as string) : (env.NUDGE_MEALS || "off").trim().toLowerCase();
    return v === "shadow" || v === "on" ? v : "off";
}

/** Regular nudges: off | shadow | on (admin flag, else NUDGE_REGULAR, else off). */
export function regularNudgeMode(env: NodeJS.ProcessEnv = process.env, flags = snapshot): "off" | "shadow" | "on" {
    const v = typeof flags["nudge.regular"] === "string" ? (flags["nudge.regular"] as string) : (env.NUDGE_REGULAR || "off").trim().toLowerCase();
    return v === "shadow" || v === "on" ? v : "off";
}

/** Invite-only sign-up: the admin switch if set, else INVITE_ONLY ("off"/"false"/"0" opens sign-up), else on. */
export function inviteOnlyEnabled(env: NodeJS.ProcessEnv = process.env, flags = snapshot): boolean {
    if (typeof flags["signup.inviteOnly"] === "boolean") return flags["signup.inviteOnly"] as boolean;
    return !["off", "false", "0", "no"].includes(String(env.INVITE_ONLY ?? "on").trim().toLowerCase());
}

/** The Food & nutrition page and its doctor links: the admin switch if set, else NUTRITION_PAGE=on, else off (the founder
 *  approves the screenshots before anyone sees it). */
export function nutritionPageEnabled(env: NodeJS.ProcessEnv = process.env, flags = snapshot): boolean {
    if (typeof flags["nutrition.page"] === "boolean") return flags["nutrition.page"] as boolean;
    return String(env.NUTRITION_PAGE ?? "").trim().toLowerCase() === "on";
}

export function isSaheliPaused(familyId: string, flags = snapshot): boolean {
    const list = flags["saheli.pausedFamilies"];
    return Array.isArray(list) && list.includes(familyId);
}
