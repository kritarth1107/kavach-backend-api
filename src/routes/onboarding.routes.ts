/** New-caregiver onboarding (signed-in user, primary caregiver of their family). */
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { protect } from "../middleware/auth.middleware";
import * as O from "../services/onboarding.service";
import { transcribeVoice, understandAnswer } from "../services/onboardingChat.service";

const router = Router();
const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: (err?: unknown) => void) =>
        fn(req, res).catch(next);
const photo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const voice = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.use(protect);
router.get("/", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.onboardingState(req.user!.userId) })));
router.put("/draft", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.saveDraft(req.user!.userId, req.body ?? {}) })));
router.post("/skip", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.skipOnboarding(req.user!.userId) })));
router.post("/verify", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.startVerification(req.user!.userId, req.body ?? {}) })));
router.post("/verify/confirm", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.confirmVerification(req.user!.userId, req.body ?? {}) })));
router.get("/verify/:target", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.verificationStatus(req.user!.userId, String(req.params.target)) })));
router.post("/prescription", photo.single("file"), asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.readPrescription(req.user!.userId, req.file) })));
router.post("/understand", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await understandAnswer(req.user!.userId, req.body ?? {}) })));
router.post("/transcribe", voice.single("file"), asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await transcribeVoice(req.user!.userId, req.file) })));
router.post("/followups", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.followupQuestions(req.user!.userId, req.body?.answers) })));
router.post("/complete", asyncHandler(async (req: Request, res: Response) => res.json({ success: true, data: await O.completeOnboarding(req.user!.userId, req.body?.answers) })));

export default router;
