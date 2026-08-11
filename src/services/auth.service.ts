import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { Request } from "express";
import config from "../config/app.config";
import Session from "../models/session.model";
import User, { IUserDocument } from "../models/users.model";
import { AuthProvider } from "../types/user.types";
import { IJwtPayload } from "../types/session.types";
import TokenBlacklist from "../utils/tokenBlacklist.util";
import { SessionStatus } from "../types/session.types";
import {
  createDefaultFamilyForUser,
  getStoredFamilyContext,
  setPrimaryFamilyOnLogin,
} from "./family.service";
import {
  getPendingMembershipsForUser,
  syncPendingInviteMembershipsForUser,
  userNeedsInvitationAction,
  requiresBlockingInvitationScreen,
  type PendingInvitationSummary,
} from "./familyMember.service";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export function sanitizeUser(user: IUserDocument | Record<string, unknown>) {
  const u = user as IUserDocument;
  return {
    userId: u.userId,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName:
      [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
    avatarUrl: u.avatarUrl,
    emailVerified: u.emailVerified,
    primaryAuthProvider: u.primaryAuthProvider,
    activeFamilyId: u.activeFamilyId ?? null,
    createdAt: u.createdAt,
  };
}

export async function createAuthSession(
  user: IUserDocument,
  authProvider: AuthProvider,
  req: Request,
) {
  await ensureInternalPassword(user.userId);

  const sessionId = randomUUID();
  const payload: IJwtPayload = {
    userId: user.userId,
    email: user.email,
    sessionId,
    authProvider,
  };

  const token = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.validity as jwt.SignOptions["expiresIn"],
  });

  const expiresAt = new Date(
    Date.now() + parseExpiryMs(config.jwt.validity),
  );

  await Session.create({
    sessionId,
    userId: user.userId,
    tokenHash: Session.hashToken(token),
    fingerprint: (req.headers["x-fingerprint"] as string) || "N/A",
    authProvider,
    userAgent: req.headers["user-agent"],
    ipAddress: req.ip,
    expiresAt,
    lastActiveAt: new Date(),
  });

  await User.updateOne(
    { userId: user.userId },
    { emailVerified: true },
  );

  const loginContext = await resolveLoginFamilyContext(user);
  const refreshedUser = (await User.findOne({ userId: user.userId })) ?? user;

  return {
    token,
    user: sanitizeUser(refreshedUser),
    ...loginContext,
  };
}

export async function resolveLoginFamilyContext(user: IUserDocument) {
  await syncPendingInviteMembershipsForUser(user);

  const joinedFamilies = await import("./family.service").then((m) =>
    m.getFamiliesForUser(user.userId),
  );
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
    return {
      requiresInvitationAction: true as const,
      pendingInvitations,
      activeFamilyId: null,
      activeFamily: null,
      families: [] as PendingInvitationSummary[],
    };
  }

  if (joinedFamilies.length === 0) {
    await createDefaultFamilyForUser(user);
  } else {
    await setPrimaryFamilyOnLogin(user);
  }

  const familyContext = await getStoredFamilyContext(user.userId);

  return {
    requiresInvitationAction: false as const,
    pendingInvitations: hasPendingInvites ? pendingInvitations : [],
    activeFamilyId: familyContext?.activeFamilyId ?? null,
    activeFamily: familyContext?.activeFamily ?? null,
    families: familyContext?.families ?? [],
  };
}

export async function generatePasswordHash() {
  const raw = randomBytes(24).toString("hex");
  const passwordHash = await bcrypt.hash(raw, config.security.bcryptSaltRounds);
  return passwordHash;
}

/** OTP/social users get a random internal password — never used for login. */
export async function ensureInternalPassword(userId: string): Promise<void> {
  const user = await User.findOne({ userId }).select("+passwordHash");
  if (user?.passwordHash) {
    return;
  }

  const passwordHash = await generatePasswordHash();
  await User.updateOne({ userId }, { passwordHash });
}

export async function verifyGoogleIdToken(idToken: string) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Invalid Google token payload");
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name,
    picture: payload.picture,
    emailVerified: payload.email_verified ?? false,
  };
}

export async function findOrCreateGoogleUser(profile: {
  googleId: string;
  email: string;
  name?: string;
  picture?: string;
  emailVerified: boolean;
}) {
  let user = await User.findBySocialAccount(AuthProvider.GOOGLE, profile.googleId);

  if (!user) {
    user = await User.findOne({ email: profile.email });
  }

  if (user) {
    await ensureInternalPassword(user.userId);

    if (!user.hasSocialAccount(AuthProvider.GOOGLE)) {
      await user.linkSocialAccount({
        provider: AuthProvider.GOOGLE,
        providerId: profile.googleId,
        email: profile.email,
        displayName: profile.name,
        avatarUrl: profile.picture,
      });
    } else {
      const account = user.getSocialAccount(AuthProvider.GOOGLE);
      if (account) {
        account.lastUsedAt = new Date();
        if (profile.picture) user.avatarUrl = profile.picture;
        await user.save();
      }
    }
  } else {
    const [firstName, ...rest] = (profile.name ?? profile.email.split("@")[0]).split(" ");
    const passwordHash = await generatePasswordHash();

    user = await User.create({
      email: profile.email,
      firstName,
      lastName: rest.join(" ") || undefined,
      avatarUrl: profile.picture,
      passwordHash,
      primaryAuthProvider: AuthProvider.GOOGLE,
      emailVerified: profile.emailVerified,
      socialAccounts: [
        {
          provider: AuthProvider.GOOGLE,
          providerId: profile.googleId,
          email: profile.email,
          displayName: profile.name,
          avatarUrl: profile.picture,
          linkedAt: new Date(),
          lastUsedAt: new Date(),
        },
      ],
    });

    await createDefaultFamilyForUser(user);
  }

  return user;
}

export async function findOrCreateEmailUser(email: string, fullName: string) {
  let user = await User.findOne({ email: email.toLowerCase() });

  if (user) {
    await ensureInternalPassword(user.userId);
    return user;
  }

  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const passwordHash = await generatePasswordHash();

  user = await User.create({
    email: email.toLowerCase(),
    firstName,
    lastName: rest.join(" ") || undefined,
    passwordHash,
    primaryAuthProvider: AuthProvider.EMAIL,
    emailVerified: true,
  });

  return user;
}

export async function findOrCreatePhoneUser(
  countryCode: string,
  number: string,
  fullName: string,
) {
  let user = await User.findByPhone(countryCode, number);

  if (user) {
    await ensureInternalPassword(user.userId);
    return user;
  }

  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const passwordHash = await generatePasswordHash();
  const placeholderEmail = `${randomBytes(16).toString("hex")}@pending.kavach`;

  user = await User.create({
    email: placeholderEmail,
    firstName,
    lastName: rest.join(" ") || undefined,
    phone: { countryCode, number },
    passwordHash,
    primaryAuthProvider: AuthProvider.EMAIL,
    emailVerified: false,
  });

  return user;
}

export async function revokeSessionFromToken(token: string) {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as IJwtPayload;

    await Session.updateOne(
      { sessionId: decoded.sessionId, userId: decoded.userId },
      { status: SessionStatus.REVOKED },
    );

    await TokenBlacklist.blacklistToken(
      token,
      Math.floor(parseExpiryMs(config.jwt.validity) / 1000),
    );
  } catch {
    // Token already invalid or expired — still proceed with logout
  }
}

function parseExpiryMs(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}
