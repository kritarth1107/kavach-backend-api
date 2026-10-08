import { NextFunction, Request, Response } from "express";
import User from "../models/users.model";
import Family from "../models/family.model";
import { FamilyMemberStatus } from "../types/family.types";
import { isCareRecipientOnly } from "../services/loginGate";
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
  sendPhoneSignInCode,
} from "../services/whatsappOtp.service";
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
  findUserByContactEmail,
} from "../services/familyMember.service";
import { AuthProvider } from "../types/user.types";
import { NormalizedPhone, normalizePhoneInput } from "../utils/phone.util";
import { findPhoneOwner } from "../services/phoneOwner.service";
import appConfig from "../config/app.config";

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
    return findUserByContactEmail(context.email);
  }

  // A parent's number may be known only from their family invitation or WhatsApp link: still theirs.
  return findPhoneOwner(context.phone.countryCode, context.phone.number);
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


// Mobile sign-in codes go on WhatsApp (approved "otp" template); on when PHONE_OTP_ENABLED=true.
const phoneLoginEnabled = () => process.env.PHONE_OTP_ENABLED === "true";

/** The number was just proven with a WhatsApp code: onboarding won't ask to verify it again. */
async function markPhoneVerified(userId: string, context: OtpContext) {
  if (context.channel !== "phone") return;
  await User.updateOne({ userId, phoneKey: context.phone.key }, { $set: { phoneVerifiedAt: new Date() } });
}

const PHONE_LOGIN_DISABLED =
  "Mobile sign-in isn't available yet. Please use your email or Google.";

const CARE_RECIPIENT_LOGIN_DENIED =
  "This number belongs to someone Saheli looks after. There's nothing to sign in to: just message Saheli on WhatsApp. Family caregivers sign in here with their own number or email.";

async function assertDashboardLoginAllowed(userId: string) {
  const families = await Family.find({
    members: {
      $elemMatch: {
        userId,
        status: { $in: [FamilyMemberStatus.JOINED, FamilyMemberStatus.PENDING, "ACTIVE"] },
      },
    },
  })
    .select("members")
    .lean();
  if (isCareRecipientOnly(userId, families.flatMap((family) => family.members))) {
    throw new AppError(CARE_RECIPIENT_LOGIN_DENIED, 403, { code: "care_recipient", data: { saheliNumber: appConfig.whatsapp.kavachNumber } });
  }
}

/**
 * Last guard before a code goes out or an account is created: a number someone in a family already has (on an
 * invitation or WhatsApp link) is never a new account, even if their own account record could not be found.
 */
async function assertNumberFree(context: OtpContext) {
  if (context.channel !== "phone") return;
  const { findPhoneHolder } = await import("../services/phoneOwner.service");
  const holder = await findPhoneHolder(context.phone.countryCode, context.phone.number);
  if (!holder) return;
  await assertDashboardLoginAllowed(holder.userId);
  throw new AppError("This number is already linked to someone in a family on Kavach. Sign in with your own number or email.", 409);
}

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
    await assertDashboardLoginAllowed(user.userId);
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
    if (context.channel === "phone" && !phoneLoginEnabled()) {
      throw new AppError(PHONE_LOGIN_DISABLED, 403);
    }

    const existingUser = await findExistingUser(context);
    if (existingUser) {
      await assertDashboardLoginAllowed(existingUser.userId);
    } else {
      await assertNumberFree(context);
    }

    if (context.channel === "email") {
      const code = generateOtpCode();
      const otpToken = await createOtpToken("email", context.email, code);
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
    const otpToken = await createOtpToken("phone", context.phone.key, code);
    await sendPhoneSignInCode(context.phone, code);

    res.json({
      success: true,
      message: "Verification code sent on WhatsApp",
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

    if (context.channel === "phone" && !phoneLoginEnabled()) {
      throw new AppError(PHONE_LOGIN_DISABLED, 403);
    }

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

    await assertDashboardLoginAllowed(existingUser.userId);
    await markPhoneVerified(existingUser.userId, context);

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

    if (context.channel === "phone" && !phoneLoginEnabled()) {
      throw new AppError(PHONE_LOGIN_DISABLED, 403);
    }

    // Always check the code, even when the account already exists.
    const result = await verifyOtpToken(channel, identifier, code, otpToken, {
      consume: true,
    });
    if (!result.valid) {
      throw new AppError(otpErrorMessages[result.reason], 400);
    }

    let user = await findExistingUser(context);
    let isNewUser = false;

    if (!user) {
      await assertNumberFree(context);
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

    await assertDashboardLoginAllowed(user.userId);
    await markPhoneVerified(user.userId, context);
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
