import { Router } from "express";
import {
    getWhatsAppMetaWebhook,
    postPhoneMockWebhook,
    postSpeakerMockWebhook,
    postWhatsAppBaileysWebhook,
    postWhatsAppMetaWebhook,
    postWhatsAppMockWebhook,
} from "../controllers/careRecord.controller";
import { requireBridgeSecret } from "../middleware/bridgeAuth.middleware";

const router = Router();

router.post("/whatsapp/mock", postWhatsAppMockWebhook);
router.get("/whatsapp/meta", getWhatsAppMetaWebhook);
router.post("/whatsapp/meta", postWhatsAppMetaWebhook);
router.post("/whatsapp/baileys", requireBridgeSecret, postWhatsAppBaileysWebhook);
router.post("/phone/mock", postPhoneMockWebhook);
router.post("/speaker/mock", postSpeakerMockWebhook);

export default router;
