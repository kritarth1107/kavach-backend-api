import { Resend } from "resend";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

let client: Resend | null = null;

/** Real email goes out only from production (NODE_ENV=production, as on ECS), or with EMAIL_SEND=on. A test or script run
 * on a laptop with a live key in .env used to email the founder test alerts ("[Kavach ops] s", fam-w, 15 Oct 00:03). */
export function realEmailAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.EMAIL_SEND || "").trim().toLowerCase() === "on") return true;
  if ((env.EMAIL_SEND || "").trim().toLowerCase() === "off") return false;
  return (env.NODE_ENV || "").trim().toLowerCase() === "production";
}

const held = {
  emails: {
    send: async (msg: Record<string, unknown>) => {
      console.log(`[email] not sent outside production: ${String(msg.subject ?? "").slice(0, 80)}`);
      return { data: null, error: null };
    },
  },
} as unknown as Resend;

/** Created on first send, so importing this module (tests, scripts) needs no key. */
function resend(): Resend {
  if (client) return client;
  return realEmailAllowed() ? (client = new Resend(config.email.resendApiKey)) : held;
}

/** Tests: send through a fake (it gets what Resend would; return { error } to simulate a failure). null restores Resend. */
export function setEmailClientForTests(fake: { emails: { send: (msg: Record<string, unknown>) => Promise<{ error?: { message?: string } | null }> } } | null) {
  client = fake as unknown as Resend | null;
}

export async function sendOtpEmail(email: string, code: string) {
  const { error } = await resend().emails.send({
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

  const { error } = await resend().emails.send({
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

/** The waitlist approval email: a big "Complete your sign-up" button with the personal one-time web link. */
export async function sendWaitlistApprovedEmail(params: { to: string; name: string; registerUrl: string }) {
  const { renderWaitlistApprovedEmail } = await import("./waitlistEmail.template");
  const { APPROVAL_LINK_TTL_DAYS } = await import("./invite.service");
  const mail = renderWaitlistApprovedEmail({ ...params, validDays: APPROVAL_LINK_TTL_DAYS });
  const { error } = await resend().emails.send({
    from: process.env.WAITLIST_EMAIL_FROM || "Saheli at Kavach <saheli@emails.kavach.care>",
    to: params.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (error) throw new AppError(error.message || "Failed to send approval email", 502);
  return { sent: true };
}

/** What may email the Kavach team. Founder, 17 Oct 2026: only the crisis alert (a user talking of suicide, self-harm,
 *  wanting to die or harming someone). Ops alerts, monitors, delivery reports, daily and nightly scores and the
 *  emergency-with-no-one-else note are kept in the admin console and the logs instead. */
export type TeamMail = "crisis" | "emergency_alone" | "ops" | "report";

export function teamEmailAllowed(kind: TeamMail): boolean {
  return kind === "crisis";
}

/** A team note that is not emailed: one log line, so it still shows in the backend logs. */
function muted(kind: TeamMail, subject: string) {
  console.log(`[team-note] not emailed (${kind}): ${subject.replace(/\s+/g, " ").slice(0, 160)}`);
  return { sent: false, muted: true, to: 0 } as const;
}

/** An operations note (credits running out, a vendor down, a saved store step broke). Not emailed (teamEmailAllowed). */
export async function sendOpsAlert(subject: string, _text: string) {
  return muted("ops", `[Kavach] ${subject}`);
}

/** The team's daily score and nightly world score (trust plan C1, C2). Not emailed (teamEmailAllowed); the admin
 *  console keeps them. */
export async function sendTeamReport(subject: string, _text: string, _html?: string) {
  return muted("report", subject);
}

/** A care alert to the Kavach care team. Only `crisis` is emailed (teamEmailAllowed); CARE_TEAM_ALERT_TO overrides the
 *  recipients (comma separated). */
export async function sendCareTeamAlert(subject: string, text: string, kind: TeamMail = "ops") {
  if (!teamEmailAllowed(kind)) return muted(kind, subject);
  const to = (process.env.CARE_TEAM_ALERT_TO || process.env.OPS_ALERT_TO || "kritarth@kavach.care").split(",").map((x) => x.trim()).filter(Boolean);
  const { error } = await resend().emails.send({
    from: process.env.CARE_TEAM_ALERT_FROM || "Kavach care alert <alerts@emails.kavach.care>",
    to,
    subject: subject.slice(0, 160),
    text: text.slice(0, 8000),
  });
  if (error) throw new AppError(error.message || "Failed to send care team alert", 502);
  return { sent: true, to: to.length };
}

/** A short care email to a family member (Saheli: an order is stuck and needs them). Plain text; the reply is on WhatsApp. */
export async function sendFamilyEmail(to: string, subject: string, text: string) {
  const { error } = await resend().emails.send({
    from: process.env.FAMILY_EMAIL_FROM || "Saheli at Kavach <saheli@emails.kavach.care>",
    to,
    subject: subject.slice(0, 160),
    text: `${text.slice(0, 3000)}\n\nReply to Saheli on WhatsApp. — Kavach`,
  });
  if (error) throw new AppError(error.message || "Failed to send email", 502);
  return { sent: true };
}
