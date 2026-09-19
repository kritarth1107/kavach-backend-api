import { Router } from "express";
import {
    getWhatsAppMetaWebhook,
    getWhatsAppMetaWebhookDebug,
    postWhatsAppMetaSetup,
    postWhatsAppMetaSubscribeWaba,
    postPhoneMockWebhook,
    postSpeakerMockWebhook,
    postWhatsAppMetaWebhook,
    postWhatsAppMockWebhook,
} from "../controllers/careRecord.controller";

const router = Router();

router.post("/whatsapp/mock", postWhatsAppMockWebhook);
router.get("/whatsapp/meta", getWhatsAppMetaWebhook);
router.get("/whatsapp/meta/debug", getWhatsAppMetaWebhookDebug);
router.post("/whatsapp/meta/setup", postWhatsAppMetaSetup);
router.post("/whatsapp/meta/subscribe-waba", postWhatsAppMetaSubscribeWaba);
router.post("/whatsapp/meta", postWhatsAppMetaWebhook);
router.post("/phone/mock", postPhoneMockWebhook);
router.post("/speaker/mock", postSpeakerMockWebhook);

export default router;
