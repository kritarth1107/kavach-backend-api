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
    "connectors.mcpFirst": {
        type: "bool", env: "MCP_AGENT_CONNECTOR", envOn: "on", label: "Store connectors first",
        help: "Swiggy, Instamart and Zepto through their connectors first, the browser as fallback.",
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

export function isSaheliPaused(familyId: string, flags = snapshot): boolean {
    const list = flags["saheli.pausedFamilies"];
    return Array.isArray(list) && list.includes(familyId);
}
