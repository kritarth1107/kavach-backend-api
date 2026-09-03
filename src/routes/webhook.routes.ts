import { Router } from "express";
import {
    postPhoneMockWebhook,
    postSpeakerMockWebhook,
    postWhatsAppMockWebhook,
} from "../controllers/careRecord.controller";

const router = Router();

router.post("/whatsapp/mock", postWhatsAppMockWebhook);
router.post("/phone/mock", postPhoneMockWebhook);
router.post("/speaker/mock", postSpeakerMockWebhook);

export default router;
