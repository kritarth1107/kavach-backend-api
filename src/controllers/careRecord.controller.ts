import { Request, Response } from "express";
import { ChannelType } from "../types/careRecord.types";
import { whatsAppMockAdapter, phoneMockAdapter, smartSpeakerMockAdapter } from "../channels/whatsappMock.adapter";
import {
    listCareRecordEvents,
    getCareRecordTimeline,
    getWeeklyMetrics,
} from "../services/careRecord.service";
import { generateCareBrief } from "../services/careBrief.service";
import {
    suggestOrder,
    listPendingApprovals,
    approveOrder,
    payOrder,
    rejectOrder,
    listOrderHistory,
} from "../services/order.service";
import { upsertChannelIdentity, listChannelIdentities } from "../services/identityResolver.service";
import { getFamilyIntegrations } from "../services/integration.service";
import { getFamilyForActor, requirePermission } from "../services/careRecordAuth.service";

export async function getCareRecordEventsHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const typeFilter = req.query.type as string | undefined;
    const types = typeFilter ? [typeFilter as never] : undefined;

    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        types,
        limit: Number(req.query.limit ?? 50),
    });

    res.json({ success: true, data: { events } });
}

export async function getCareRecordTimelineHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const events = await getCareRecordTimeline({
        familyId,
        subjectUserId,
        limit: Number(req.query.limit ?? 100),
    });

    res.json({ success: true, data: { events } });
}

export async function getCareRecordMetricsHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const metrics = await getWeeklyMetrics(familyId, subjectUserId);
    res.json({ success: true, data: metrics });
}

export async function getCareBriefHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const brief = await generateCareBrief(familyId, subjectUserId, req.user!.userId);
    res.json({ success: true, data: brief });
}

export async function getPendingApprovalsHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const orders = await listPendingApprovals(familyId, req.user!.userId);
    res.json({
        success: true,
        data: {
            orders: orders.map((o) => ({
                order_id: o.orderId,
                status: o.status,
                total_paise: o.totalPaise,
                items: o.items,
                deep_link: o.deepLink,
                subject_user_id: o.subjectUserId,
                created_at: o.createdAt?.toISOString() ?? null,
            })),
        },
    });
}

export async function postApproveOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const order = await approveOrder(familyId, orderId, req.user!.userId);
    res.json({ success: true, data: { order_id: order.orderId, status: order.status } });
}

export async function postPayOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const result = await payOrder(familyId, orderId, req.user!.userId);
    res.json({
        success: true,
        data: {
            order_id: result.order.orderId,
            status: result.order.status,
            payment_id: result.payment.paymentId,
            payment_link: result.payment.paymentLink ?? result.payment.deepLink ?? null,
            provider: result.payment.provider,
        },
    });
}

export async function postRejectOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const order = await rejectOrder(familyId, orderId, req.user!.userId);
    res.json({ success: true, data: { order_id: order.orderId, status: order.status } });
}

export async function getOrderHistoryHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const orders = await listOrderHistory(familyId, req.user!.userId);
    res.json({
        success: true,
        data: {
            orders: orders.map((o) => ({
                order_id: o.orderId,
                status: o.status,
                total_paise: o.totalPaise,
                items: o.items,
                deep_link: o.deepLink,
                created_at: o.createdAt?.toISOString() ?? null,
            })),
        },
    });
}

export async function getIntegrationsHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const data = await getFamilyIntegrations(familyId, req.user!.userId);
    res.json({ success: true, data });
}

export async function postSuggestOrderHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const items = req.body?.items ?? [];
    const order = await suggestOrder({
        familyId,
        subjectUserId,
        actorUserId: req.user!.userId,
        items,
        notes: req.body?.notes,
        deliveryAddress: req.body?.deliveryAddress,
    });
    res.status(201).json({
        success: true,
        data: {
            order_id: order.orderId,
            status: order.status,
            total_paise: order.totalPaise,
            deep_link: order.deepLink,
        },
    });
}

export async function postChannelIdentityHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "manage_schedule");

    const row = await upsertChannelIdentity({
        channelType: req.body.channelType,
        channelIdentifier: req.body.channelIdentifier,
        familyId,
        userId: req.body.userId,
        role: req.body.role,
        label: req.body.label,
    });

    res.status(201).json({ success: true, data: row });
}

export async function getChannelIdentitiesHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    await getFamilyForActor(familyId, actorUserId);
    const rows = await listChannelIdentities(familyId);
    res.json({ success: true, data: { identities: rows } });
}

export async function postWhatsAppMockWebhook(req: Request, res: Response) {
    const adapter = whatsAppMockAdapter;
    const { reply } = await adapter.receive({
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: req.body.from,
        modality: req.body.modality ?? "text",
        content: req.body.text ?? "",
        audioBase64: req.body.audioBase64,
        timestamp: new Date(),
    });
    res.json({ success: true, data: { reply } });
}

export async function postPhoneMockWebhook(req: Request, res: Response) {
    const { reply } = await phoneMockAdapter.receive({
        channelType: ChannelType.PHONE,
        channelIdentifier: req.body.from,
        modality: "voice",
        content: req.body.text ?? "",
        audioBase64: req.body.audioBase64,
    });
    res.json({ success: true, data: { reply } });
}

export async function postSpeakerMockWebhook(req: Request, res: Response) {
    const { reply } = await smartSpeakerMockAdapter.receive({
        channelType: ChannelType.SMART_SPEAKER,
        channelIdentifier: req.body.deviceId,
        modality: "voice",
        content: req.body.text ?? "",
        audioBase64: req.body.audioBase64,
    });
    res.json({ success: true, data: { reply } });
}
