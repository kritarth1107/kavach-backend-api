import { Router } from "express";
import {
  getMe,
  googleAuth,
  login,
  logout,
  register,
  registerWithOtp,
  sendOtp,
  verifyOtp,
} from "../controllers/auth.controller";
import { protect } from "../middleware/auth.middleware";

const router = Router();

router.post("/google", googleAuth);
router.post("/otp/send", sendOtp);
router.post("/otp/verify", verifyOtp);
router.post("/otp/register", registerWithOtp);
router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.get("/me", protect, getMe);

export default router;
