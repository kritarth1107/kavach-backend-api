import { Router } from "express";
import {
    postPhoneMockWebhook,
    postSpeakerMockWebhook,
    postWhatsAppBaileysWebhook,
    postWhatsAppMockWebhook,
} from "../controllers/careRecord.controller";
import { requireBridgeSecret } from "../middleware/bridgeAuth.middleware";

const router = Router();

router.post("/whatsapp/mock", postWhatsAppMockWebhook);
router.post("/whatsapp/baileys", requireBridgeSecret, postWhatsAppBaileysWebhook);
router.post("/phone/mock", postPhoneMockWebhook);
router.post("/speaker/mock", postSpeakerMockWebhook);

export default router;
