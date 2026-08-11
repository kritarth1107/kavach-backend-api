import { NextFunction, Request, Response } from "express";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import { sendOtpEmail } from "../services/email.service";
import {
  createOtpToken,
  generateOtpCode,
  OtpChannel,
  verifyOtpToken,
} from "../services/otp.service";
import {
  generatePhoneOtpCode,
  sendOtpSms,
} from "../services/sms.service";
import {
  createAuthSession,
  findOrCreateEmailUser,
  findOrCreateGoogleUser,
  findOrCreatePhoneUser,
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
import {
  getPendingMembershipsForUser,
  syncPendingInviteMembershipsForUser,
  userNeedsInvitationAction,
  requiresBlockingInvitationScreen,
} from "../services/familyMember.service";
import { AuthProvider } from "../types/user.types";
import { NormalizedPhone, normalizePhoneInput } from "../utils/phone.util";

type EmailOtpContext = {
  channel: "email";
  email: string;
};

type PhoneOtpContext = {
  channel: "phone";
  phone: NormalizedPhone;
};

type OtpContext = EmailOtpContext | PhoneOtpContext;

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

function getOtpContext(body: Request["body"]): OtpContext {
  const channel = String(body?.channel ?? "").trim().toLowerCase();
  const hasPhone =
    String(body?.phone ?? "").trim().length > 0 ||
    String(body?.phoneCountryCode ?? "").trim().length > 0;

  if (channel === "phone" || (!channel && hasPhone && !body?.email)) {
    const phone = normalizePhoneInput(
      String(body?.phoneCountryCode ?? "+91"),
      String(body?.phone ?? ""),
    );
    return { channel: "phone", phone };
  }

  return { channel: "email", email: getEmail(body) };
}

async function findExistingUser(context: OtpContext) {
  if (context.channel === "email") {
    return User.findOne({ email: context.email });
  }

  return User.findByPhone(context.phone.countryCode, context.phone.number);
}

function otpIdentifier(context: OtpContext): { channel: OtpChannel; identifier: string } {
  if (context.channel === "email") {
    return { channel: "email", identifier: context.email };
  }

  return { channel: "phone", identifier: context.phone.key };
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
    const context = getOtpContext(req.body);

    if (context.channel === "email") {
      const code = generateOtpCode();
      const otpToken = createOtpToken("email", context.email, code);
      await sendOtpEmail(context.email, code);

      res.json({
        success: true,
        message: "Verification code sent to your email",
        data: {
          channel: "email" as const,
          email: context.email,
          otpToken,
        },
      });
      return;
    }

    const code = generatePhoneOtpCode();
    const otpToken = createOtpToken("phone", context.phone.key, code);
    await sendOtpSms(context.phone.countryCode, context.phone.number, code);

    res.json({
      success: true,
      message: "Verification code sent to your mobile",
      data: {
        channel: "phone" as const,
        phone: context.phone.number,
        phoneCountryCode: context.phone.countryCode,
        otpToken,
      },
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
    const context = getOtpContext(req.body);
    const code = getOtpCode(req.body);
    const otpToken = getOtpToken(req.body);
    const { channel, identifier } = otpIdentifier(context);

    const existingUser = await findExistingUser(context);

    const result = await verifyOtpToken(channel, identifier, code, otpToken, {
      consume: Boolean(existingUser),
    });

    if (!result.valid) {
      throw new AppError(otpErrorMessages[result.reason], 400);
    }

    if (!existingUser) {
      res.json({
        success: true,
        message: "Code verified. Complete your registration.",
        data:
          context.channel === "email"
            ? {
                channel: "email" as const,
                registered: false,
                email: context.email,
              }
            : {
                channel: "phone" as const,
                registered: false,
                phone: context.phone.number,
                phoneCountryCode: context.phone.countryCode,
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
        channel: context.channel,
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
    const context = getOtpContext(req.body);
    const code = getOtpCode(req.body);
    const otpToken = getOtpToken(req.body);
    const fullName = String(req.body?.name ?? req.body?.firstName ?? "").trim();
    const { channel, identifier } = otpIdentifier(context);

    if (!fullName || fullName.length < 2) {
      throw new AppError("Your name is required to register", 400);
    }

    let user = await findExistingUser(context);
    let isNewUser = false;

    if (!user) {
      const result = await verifyOtpToken(channel, identifier, code, otpToken, {
        consume: true,
      });

      if (!result.valid) {
        throw new AppError(otpErrorMessages[result.reason], 400);
      }

      if (context.channel === "email") {
        user = await findOrCreateEmailUser(context.email, fullName);
      } else {
        user = await findOrCreatePhoneUser(
          context.phone.countryCode,
          context.phone.number,
          fullName,
        );
      }
      isNewUser = true;
    }

    const session = await createAuthSession(user, AuthProvider.EMAIL, req);

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? "Account created successfully" : "Signed in successfully",
      data: {
        channel: context.channel,
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
