import { Resend } from "resend";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

const resend = new Resend(config.email.resendApiKey);

export async function sendOtpEmail(email: string, code: string) {
  const { error } = await resend.emails.send({
    from: config.email.from,
    to: email,
    subject: `${code} is your Kavach sign-in code`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #16a34a; margin-bottom: 8px;">Kavach</h2>
        <p style="color: #374151; font-size: 15px;">Use this code to sign in to your account:</p>
        <p style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #111827; margin: 24px 0;">${code}</p>
        <p style="color: #9ca3af; font-size: 13px;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    throw new AppError(error.message || "Failed to send verification email", 502);
  }
}

export async function sendFamilyInviteEmail(params: {
  to: string;
  inviterName: string;
  familyName: string;
  roleLabel: string;
  acceptUrl: string;
}) {
  const { to, inviterName, familyName, roleLabel, acceptUrl } = params;

  const { error } = await resend.emails.send({
    from: config.email.from,
    to,
    subject: `${inviterName} invited you to ${familyName} on Kavach`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #16a34a; margin-bottom: 8px;">Kavach</h2>
        <p style="color: #374151; font-size: 15px;">
          <strong>${inviterName}</strong> invited you to join <strong>${familyName}</strong> as ${roleLabel}.
        </p>
        <p style="color: #374151; font-size: 14px;">Accept the invitation to access the family dashboard and care circle.</p>
        <a href="${acceptUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: #16a34a; color: white; text-decoration: none; border-radius: 8px; font-weight: 700;">Accept invitation</a>
        <p style="color: #9ca3af; font-size: 13px;">This link expires in 7 days. If you didn't expect this, you can ignore this email.</p>
      </div>
    `,
  });

  if (error) {
    throw new AppError(error.message || "Failed to send invitation email", 502);
  }
}
