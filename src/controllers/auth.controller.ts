import { NextFunction, Request, Response } from "express";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import { sendOtpEmail } from "../services/email.service";
import {
  createOtpToken,
  generateOtpCode,
  verifyOtpToken,
} from "../services/otp.service";
import {
  createAuthSession,
  findOrCreateEmailUser,
  findOrCreateGoogleUser,
  revokeSessionFromToken,
  sanitizeUser,
  verifyGoogleIdToken,
} from "../services/auth.service";
import {
  ensureDefaultFamily,
  buildFamilySwitcherPayload,
  getFamiliesForUser,
  getUserInitials,
  ensureValidActiveFamily,
} from "../services/family.service";
import { getPendingMembershipsForUser, syncPendingInviteMembershipsForUser, userNeedsInvitationAction, requiresBlockingInvitationScreen } from "../services/familyMember.service";
import { AuthProvider } from "../types/user.types";

function getEmail(body: Request["body"]) {
  const email = String(body?.email ?? "")
    .trim()
    .toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new AppError("A valid email address is required", 400);
  }
  return email;
}

function getOtpCode(body: Request["body"]) {
  const code = String(body?.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    throw new AppError("A valid 6-digit code is required", 400);
  }
  return code;
}

function getOtpToken(body: Request["body"]) {
  const otpToken = String(body?.otpToken ?? "").trim();
  if (!otpToken) {
    throw new AppError("OTP token is required", 400);
  }
  return otpToken;
}

const otpErrorMessages = {
  expired: "Code expired. Please request a new one.",
  invalid: "Invalid code. Please try again.",
  max_attempts: "Too many attempts. Please request a new code.",
  consumed: "Code already used. Please request a new one.",
} as const;

export const googleAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      throw new AppError("Google ID token is required", 400);
    }

    const profile = await verifyGoogleIdToken(idToken);
    const user = await findOrCreateGoogleUser(profile);
    const session = await createAuthSession(user, AuthProvider.GOOGLE, req);

    res.json({
      success: true,
      message: "Signed in with Google",
      data: session,
    });
  } catch (error) {
    next(error);
  }
};

export const sendOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const email = getEmail(req.body);
    const code = generateOtpCode();
    const otpToken = createOtpToken(email, code);
    await sendOtpEmail(email, code);

    res.json({
      success: true,
      message: "Verification code sent to your email",
      data: { email, otpToken },
    });
  } catch (error) {
    next(error);
  }
};

export const verifyOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const email = getEmail(req.body);
    const code = getOtpCode(req.body);
    const otpToken = getOtpToken(req.body);

    const existingUser = await User.findOne({ email });

    const result = await verifyOtpToken(email, code, otpToken, {
      consume: Boolean(existingUser),
    });

    if (!result.valid) {
      throw new AppError(otpErrorMessages[result.reason], 400);
    }

    if (!existingUser) {
      res.json({
        success: true,
        message: "Code verified. Complete your registration.",
        data: {
          registered: false,
          email,
        },
      });
      return;
    }

    const session = await createAuthSession(
      existingUser,
      AuthProvider.EMAIL,
      req,
    );

    res.json({
      success: true,
      message: "Signed in successfully",
      data: {
        registered: true,
        ...session,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const registerWithOtp = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const email = getEmail(req.body);
    const code = getOtpCode(req.body);
    const otpToken = getOtpToken(req.body);
    const fullName = String(req.body?.name ?? req.body?.firstName ?? "").trim();

    if (!fullName || fullName.length < 2) {
      throw new AppError("Your name is required to register", 400);
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      const session = await createAuthSession(
        existingUser,
        AuthProvider.EMAIL,
        req,
      );
      res.json({
        success: true,
        message: "Signed in successfully",
        data: { registered: true, ...session },
      });
      return;
    }

    const result = await verifyOtpToken(email, code, otpToken, { consume: true });

    if (!result.valid) {
      throw new AppError(otpErrorMessages[result.reason], 400);
    }

    const user = await findOrCreateEmailUser(email, fullName);
    const session = await createAuthSession(user, AuthProvider.EMAIL, req);

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      data: {
        registered: true,
        ...session,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const user = await User.findOne({ userId: req.user.userId });
    if (!user) {
      throw new AppError("User not found", 404);
    }

    await syncPendingInviteMembershipsForUser(user);

    const joinedFamilies = await getFamiliesForUser(user.userId);
    const pendingInvitations = await getPendingMembershipsForUser(
      user.userId,
      user.email,
    );
    const joinedFamilyIds = joinedFamilies.map((family) => family.familyId);
    const hasPendingInvites = userNeedsInvitationAction(
      joinedFamilyIds,
      pendingInvitations,
    );
    const blocking = requiresBlockingInvitationScreen(
      joinedFamilyIds,
      pendingInvitations,
    );

    if (blocking) {
      const sanitized = sanitizeUser(user);
      res.json({
        success: true,
        data: {
          user: {
            ...sanitized,
            initials: getUserInitials(
              user.firstName,
              user.lastName,
              user.email,
            ),
            phone: user.phone,
            activeFamilyId: null,
          },
          activeFamilyId: null,
          activeFamily: null,
          families: [],
          requiresInvitationAction: true,
          pendingInvitations,
        },
      });
      return;
    }

    await ensureDefaultFamily(user);

    const refreshedUser =
      (await User.findOne({ userId: user.userId })) ?? user;
    const familyAccessAlert = await ensureValidActiveFamily(refreshedUser);
    const families = await getFamiliesForUser(refreshedUser.userId);
    const sanitized = sanitizeUser(refreshedUser);
    const switcher = buildFamilySwitcherPayload(refreshedUser, families);

    res.json({
      success: true,
      data: {
        user: {
          ...sanitized,
          initials: getUserInitials(
            refreshedUser.firstName,
            refreshedUser.lastName,
            refreshedUser.email,
          ),
          phone: refreshedUser.phone,
          activeFamilyId: switcher.activeFamilyId,
        },
        ...switcher,
        requiresInvitationAction: false,
        pendingInvitations: hasPendingInvites ? pendingInvitations : [],
        familyAccessAlert,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const register = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  res.status(501).json({ success: false, message: "Use OTP or Google sign-in" });
};

export const login = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  res.status(501).json({ success: false, message: "Use OTP or Google sign-in" });
};

export const logout = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const token =
      req.cookies?.kavach_session ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (token) {
      await revokeSessionFromToken(token);
    }

    res.clearCookie("kavach_session", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    next(error);
  }
};
