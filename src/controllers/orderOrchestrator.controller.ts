import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    addOrderFlowCartItem,
    getOrderFlowSession,
    loadOrderFlowRestaurantMenu,
    resumeActiveOrderFlow,
    searchOrderFlowCatalog,
    selectOrderFlowAddress,
    startOrderFlow,
    submitOrderFlowCart,
    updateOrderFlowCartItem,
} from "../services/orderOrchestrator.service";

export async function postStartOrderSessionHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const message = String(req.body?.message ?? "").trim();
        if (!message) throw new AppError("message is required", 400);

        const flow = await startOrderFlow({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            message,
            saheliSessionId: String(req.body?.saheliSessionId ?? "").trim() || undefined,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function getActiveOrderSessionHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const saheliSessionId = String(req.query.saheliSessionId ?? "").trim() || undefined;
        const flow = await resumeActiveOrderFlow({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            saheliSessionId,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function getOrderSessionHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const flow = await getOrderFlowSession({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function patchOrderSessionAddressHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const addressId = String(req.body?.addressId ?? "").trim();
        if (!addressId) throw new AppError("addressId is required", 400);

        const flow = await selectOrderFlowAddress({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
            addressId,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function getOrderSessionCatalogHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const query = String(req.query.query ?? "").trim() || undefined;
        const flow = await searchOrderFlowCatalog({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
            query,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function getOrderSessionMenuHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId, restaurantId } = req.params;
        const flow = await loadOrderFlowRestaurantMenu({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
            restaurantId,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function postOrderSessionCartItemHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const item = req.body?.item ?? req.body;
        if (!item?.name) throw new AppError("item.name is required", 400);

        const flow = await addOrderFlowCartItem({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
            item: {
                itemId: item.itemId ? String(item.itemId) : undefined,
                name: String(item.name),
                quantity: item.quantity != null ? Number(item.quantity) : undefined,
                pricePaise: item.pricePaise != null ? Number(item.pricePaise) : undefined,
                restaurantId: item.restaurantId ? String(item.restaurantId) : undefined,
                restaurantName: item.restaurantName ? String(item.restaurantName) : undefined,
            },
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function patchOrderSessionCartItemHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const itemIndex = Number(req.body?.itemIndex);
        const quantity = Number(req.body?.quantity);
        if (!Number.isFinite(itemIndex) || !Number.isFinite(quantity)) {
            throw new AppError("itemIndex and quantity are required", 400);
        }

        const flow = await updateOrderFlowCartItem({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
            itemIndex,
            quantity,
        });
        res.json({ success: true, data: flow });
    } catch (error) {
        next(error);
    }
}

export async function postOrderSessionSubmitHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, sessionId } = req.params;
        const result = await submitOrderFlowCart({
            sessionId,
            familyId,
            actorUserId: req.user.userId,
        });
        res.json({ success: true, data: result });
    } catch (error) {
        next(error);
    }
}
