/** Loads the operator ride config (Mongo `ride_service_config`, _id "default") with a 5-min cache. */
import { mergeRideConfig, DEFAULT_RIDE_CONFIG, type RideConfig } from "./rideServices";

const TTL_MS = 5 * 60_000;
let cached: { cfg: RideConfig; at: number } | null = null;

export async function loadRideConfig(): Promise<RideConfig> {
    if (cached && Date.now() - cached.at < TTL_MS) return cached.cfg;
    try {
        const M = (await import("../../models/rideServiceConfig.model")).default;
        const doc = (await Promise.race([
            M.findById("default").lean(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("config read timeout")), 2000)),
        ])) as Record<string, unknown> | null;
        cached = { cfg: mergeRideConfig(doc), at: Date.now() };
    } catch (err) {
        console.warn(JSON.stringify({ evt: "ride_config_fallback", error: err instanceof Error ? err.message.slice(0, 120) : String(err) }));
        cached = { cfg: cached?.cfg || DEFAULT_RIDE_CONFIG, at: Date.now() - TTL_MS + 30_000 };
    }
    return cached.cfg;
}
