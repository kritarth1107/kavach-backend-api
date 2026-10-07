/** Feature flags: what each switch is, its value (or the env value it falls back to), who changed it last. */
import { AdminError } from "../auth";
import { can } from "../permissions";
import type { RouteDef } from "../router";
import FeatureFlag from "../../models/featureFlag.model";
import { FLAG_DEFS, FLAG_KEYS, refreshFlags, validFlagValue, type FlagKey } from "../../services/featureFlags.service";

function hideFamilies(key: FlagKey, v: unknown, people: boolean): unknown {
    if (people || !Array.isArray(v) || !["saheli.pausedFamilies", "brain.liveFamilies"].includes(key)) return v;
    return v.map(() => "hidden");
}

function envValue(key: FlagKey): unknown {
    const def = FLAG_DEFS[key] as { type: string; env?: string; envOn?: string };
    if (!def.env) return null;
    const raw = process.env[def.env];
    if (raw === undefined) return null;
    if (def.type === "list") return raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (def.type === "bool") return raw === (def.envOn || "true");
    return raw;
}

export function flagRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/flags", perm: "system.read", action: "flags.list",
            handler: async ({ admin }) => {
                const people = can(admin.role, "users.read"); // analysts see that a switch is set, not which families or why
                const rows = await FeatureFlag.find({ key: { $in: FLAG_KEYS } }).lean<Array<{ key: FlagKey; value: unknown; updatedBy: string; updatedAt: Date; reason?: string }>>();
                return {
                    data: {
                        flags: FLAG_KEYS.map((key) => {
                            const row = rows.find((r) => r.key === key);
                            const set = row && row.value !== null && row.value !== undefined;
                            return {
                                key, ...FLAG_DEFS[key], source: set ? "console" : "environment",
                                value: set ? hideFamilies(key, row!.value, people) : null, envValue: hideFamilies(key, envValue(key), people),
                                updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null, reason: people ? row?.reason ?? null : null,
                            };
                        }),
                    },
                };
            },
        },
        {
            method: "post", path: "/flags/:key", perm: "flags.manage", action: "flags.set",
            handler: async ({ admin, params, body }) => {
                const key = params.key as FlagKey;
                if (!FLAG_KEYS.includes(key)) throw new AdminError(404, "no_such_flag");
                const { value, expectedUpdatedAt } = (body as { value?: unknown; expectedUpdatedAt?: string | null } | undefined) || {};
                if (value === undefined || !validFlagValue(key, value)) throw new AdminError(400, "bad_input", "value doesn't fit this switch");
                const before = await FeatureFlag.findOne({ key }).lean<{ value?: unknown; updatedAt?: Date }>();
                // Whole-list saves must start from what is stored now, or someone else's pause could be undone.
                const stored = before?.updatedAt ? new Date(before.updatedAt).toISOString() : null;
                if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== stored) throw new AdminError(409, "changed_meanwhile", "Someone changed this switch since you opened the page. Reload and try again.");
                await FeatureFlag.updateOne({ key }, { $set: { key, value, updatedBy: admin.email, reason: admin.reason, updatedAt: new Date() } }, { upsert: true });
                await refreshFlags();
                const summarize = (v: unknown) => (Array.isArray(v) ? `${v.length} items` : v ?? "env");
                return { target: `flag:${key}`, detail: { from: summarize(before?.value), to: summarize(value) }, data: { key, value, takesEffectWithinSeconds: 60 } };
            },
        },
    ];
}
