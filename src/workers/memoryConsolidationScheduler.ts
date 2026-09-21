import SaheliMessage from "../models/saheliMessage.model";
import { listEnabledCompanions } from "../services/saheliCompanion.service";
import { aiPostFamilyShare } from "../clients/aiEngine.client";
import { ensureAiContext } from "../services/aiTenant.service";
import { getFamilyMembersList } from "../services/familyMember.service";

const TICK_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

export async function runMemoryConsolidationTick(): Promise<{ consolidated: number }> {
    const companions = await listEnabledCompanions();
    let consolidated = 0;

    for (const companion of companions) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const rows = await SaheliMessage.find({
            familyId: companion.familyId,
            recipientUserId: companion.recipientUserId,
            thread: "elder",
            role: "elder",
            createdAt: { $gte: since },
        })
            .sort({ createdAt: 1 })
            .limit(40)
            .lean();

        if (rows.length < 5) continue;

        const members = await getFamilyMembersList(
            companion.familyId,
            companion.recipientUserId,
        );
        const displayName =
            members.members.find((m) => m.userId === companion.recipientUserId)?.name?.trim() ||
            "Care recipient";

        const summary = rows.map((r) => r.content).join(" ").slice(0, 1200);
        const ctx = await ensureAiContext(
            companion.familyId,
            companion.recipientUserId,
            displayName,
        );

        try {
            await aiPostFamilyShare({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                shareSummary: `Weekly elder conversation highlights for memory: ${summary}`,
            });
            consolidated += 1;
        } catch (err) {
            console.warn("Memory consolidation failed:", err);
        }
    }

    return { consolidated };
}

export function startMemoryConsolidationScheduler() {
    if (process.env.SAHELI_MEMORY_CONSOLIDATION_ENABLED !== "true") return;
    if (timer) return;
    timer = setInterval(() => void runMemoryConsolidationTick(), TICK_MS);
}
