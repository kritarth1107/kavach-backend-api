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
    postPrivacyAudit,
    postSmokeFixtures,
    postMockAddressBook,
} from "../controllers/careRecord.controller";

const router = Router();

router.post("/whatsapp/mock", postWhatsAppMockWebhook);
router.post("/whatsapp/mock/privacy-audit", postPrivacyAudit);
router.post("/whatsapp/mock/smoke-fixtures", postSmokeFixtures);
router.post("/whatsapp/mock/address-book", postMockAddressBook);
router.get("/whatsapp/meta", getWhatsAppMetaWebhook);
router.get("/whatsapp/meta/debug", getWhatsAppMetaWebhookDebug);
router.post("/whatsapp/meta/setup", postWhatsAppMetaSetup);
router.post("/whatsapp/meta/subscribe-waba", postWhatsAppMetaSubscribeWaba);
router.post("/whatsapp/meta", postWhatsAppMetaWebhook);
router.post("/phone/mock", postPhoneMockWebhook);
router.post("/speaker/mock", postSpeakerMockWebhook);

export default router;
