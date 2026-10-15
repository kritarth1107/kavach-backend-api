/**
 * A tap the backend handled without an engine turn (a reminder's Done, the opener's "Show message").
 * The engine otherwise reads a closed chat only at the next morning. This pulls that one person forward.
 */
import { aiEngineJson } from "../clients/aiEngine.client";

export async function pullNudgeDue(familyId: string, userId: string): Promise<void> {
    if (!familyId || !userId) return;
    try {
        await aiEngineJson("POST", "/v2/jobs/nudge-due", { family_id: familyId, person_id: userId }, 8_000);
    } catch (err) {
        console.warn("nudge due pull failed:", err instanceof Error ? err.message : err);
    }
}
