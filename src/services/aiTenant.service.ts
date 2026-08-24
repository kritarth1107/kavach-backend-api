import Family from "../models/family.model";
import AiTenant from "../models/aiTenant.model";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import { aiCreateElder, aiCreateFamily } from "../clients/aiEngine.client";

function elderSlug(recipientUserId: string): string {
    const cleaned = recipientUserId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    return `r-${cleaned.slice(0, 48) || "member"}`;
}

export type AiContext = {
    aiFamilyId: string;
    aiElderId: string;
    conversationId?: string;
    caregiverConversationId?: string;
};

export async function getExistingAiContext(
    familyId: string,
    recipientUserId: string,
): Promise<AiContext | null> {
    const link = await AiTenant.findOne({ familyId }).lean();
    if (!link) return null;
    const elderLink = link.elders.find((e) => e.recipientUserId === recipientUserId);
    if (!elderLink) return null;
    return {
        aiFamilyId: link.aiFamilyId,
        aiElderId: elderLink.aiElderId,
        conversationId: elderLink.conversationId,
        caregiverConversationId: elderLink.caregiverConversationId,
    };
}

export async function ensureAiContext(
    familyId: string,
    recipientUserId: string,
    recipientDisplayName: string,
): Promise<AiContext> {
    let link = await AiTenant.findOne({ familyId });
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    if (!link) {
        const owner = await User.findOne({ userId: family.createdBy }).lean();
        const aiFamilyId = await aiCreateFamily({
            name: family.name,
            ownerExternalId: family.createdBy,
            ownerEmail: owner?.email,
            ownerName: owner
                ? [owner.firstName, owner.lastName].filter(Boolean).join(" ")
                : undefined,
        });
        link = await AiTenant.create({ familyId, aiFamilyId, elders: [] });
    }

    let elderLink = link.elders.find((e) => e.recipientUserId === recipientUserId);
    if (!elderLink) {
        const { elderId } = await aiCreateElder({
            aiFamilyId: link.aiFamilyId,
            displayName: recipientDisplayName || "Care recipient",
            slug: elderSlug(recipientUserId),
        });
        elderLink = { recipientUserId, aiElderId: elderId };
        link.elders.push(elderLink);
        await link.save();
    }

    return {
        aiFamilyId: link.aiFamilyId,
        aiElderId: elderLink.aiElderId,
        conversationId: elderLink.conversationId,
        caregiverConversationId: elderLink.caregiverConversationId,
    };
}

export async function persistCaregiverConversationId(
    familyId: string,
    recipientUserId: string,
    conversationId: string,
): Promise<void> {
    await AiTenant.updateOne(
        { familyId, "elders.recipientUserId": recipientUserId },
        { $set: { "elders.$.caregiverConversationId": conversationId } },
    );
}

export async function persistConversationId(
    familyId: string,
    recipientUserId: string,
    conversationId: string,
): Promise<void> {
    await AiTenant.updateOne(
        { familyId, "elders.recipientUserId": recipientUserId },
        { $set: { "elders.$.conversationId": conversationId } },
    );
}
