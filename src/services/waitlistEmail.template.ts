/**
 * The waitlist approval email (founder 2026-10-13: "send email to user when admin approves their waitlist, create an
 * awesome designed email"). Web first, then WhatsApp (founder 2026-10-13: "people can only access saheli via whatsapp
 * when they have completed the onboarding via web. so send saheli hi should appear at end of onboarding"): the one
 * button is "Complete your sign-up" (their personal one-time web link); the "Send hi to Saheli" button comes at the end
 * of the setup there. Care OS v3: jade pine for filled elements, marigold accent with dark text on it, charcoal ink on
 * sage-grey neutrals, flat, Geist/system fonts. Table layout and inline styles only, so Gmail, Outlook and phone mail
 * apps all draw it the same; a plain-text part goes with it.
 */

const C = {
    page: "#eceeea",
    frame: "#ffffff",
    card: "#f4f5f2",
    line: "#e3e6e0",
    ink: "#1b201e",
    ink2: "#5e6661",
    ink3: "#99a09b",
    solid: "#165246",
    onSolid: "#ffffff",
    solidSoft: "#e3efea",
    accent: "#ec9a2f",
    accentInk: "#2a1804",
    accentText: "#9a5507",
};
const FONT = "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
/** The wordmark the dashboard itself serves (already public, PNG so every mail app shows it). */
export const LOGO_URL = "https://app.kavach.care/kavach-careos-logo.png";

const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type WaitlistApprovedEmail = { subject: string; html: string; text: string };

export function renderWaitlistApprovedEmail(input: {
    name?: string | null;
    registerUrl: string;
    validDays?: number;
}): WaitlistApprovedEmail {
    const first = String(input.name ?? "").trim().split(/\s+/)[0]?.slice(0, 40) || "";
    const hello = first ? `${first}, your place` : "Your place";
    const subject = first ? `${first}, your place on Kavach is ready` : "Your place on Kavach is ready";
    const days = input.validDays ?? 30;
    const reg = esc(input.registerUrl);

    const point = (title: string, body: string) => `
              <tr>
                <td width="18" valign="top" style="padding:5px 0 0 0;">
                  <div style="width:8px;height:8px;background:${C.accent};border-radius:2px;font-size:0;line-height:0;">&nbsp;</div>
                </td>
                <td valign="top" style="padding:0 0 14px 0;font-family:${FONT};">
                  <div style="font-size:15px;line-height:22px;font-weight:600;color:${C.ink};">${title}</div>
                  <div style="font-size:14px;line-height:21px;color:${C.ink2};">${body}</div>
                </td>
              </tr>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<style>
  @media only screen and (max-width: 600px) {
    .k-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .k-h1 { font-size: 28px !important; line-height: 34px !important; }
    .k-btn a { font-size: 17px !important; padding: 18px 20px !important; }
  }
  a { text-decoration: none; }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};font-size:1px;line-height:1px;">
    You're off the waitlist. Complete your sign-up and meet Saheli in a few minutes.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr>
            <td style="background:${C.frame};border-radius:24px;border:1px solid ${C.line};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="k-pad" style="padding:32px 40px 8px 40px;">
                    <img src="${LOGO_URL}" width="128" height="36" alt="Kavach" style="display:block;border:0;outline:none;width:128px;height:auto;color:${C.solid};font-family:${FONT};font-size:22px;font-weight:700;">
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:20px 40px 0 40px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="background:${C.accent};border-radius:999px;padding:6px 14px;font-family:${FONT};font-size:13px;line-height:16px;font-weight:600;color:${C.accentInk};">
                          You're off the waitlist
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:18px 40px 0 40px;font-family:${FONT};">
                    <h1 class="k-h1" style="margin:0;font-size:32px;line-height:38px;letter-spacing:-0.03em;font-weight:400;color:${C.ink3};">
                      ${esc(hello)}<br><span style="color:${C.ink};font-weight:600;">on Kavach is ready.</span>
                    </h1>
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:16px 40px 0 40px;font-family:${FONT};font-size:16px;line-height:25px;color:${C.ink2};">
                    Thank you for waiting. Saheli, our care companion, is ready to meet you and the people you look after.
                    Complete your sign&#8209;up on the web and she'll get to know your family in a short chat: who you care for,
                    their medicines, the language they speak.
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:28px 40px 0 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="k-btn" align="center" bgcolor="${C.solid}" style="background:${C.solid};border-radius:16px;">
                          <a href="${reg}" target="_blank" style="display:block;padding:20px 24px;font-family:${FONT};font-size:18px;line-height:22px;font-weight:600;color:${C.onSolid};text-decoration:none;border-radius:16px;">
                            Complete your sign-up &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" align="center" style="padding:12px 40px 0 40px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.ink2};">
                    It takes a few minutes. At the end of setup you'll get a <span style="color:${C.ink};font-weight:600;">Send&nbsp;hi&nbsp;to&nbsp;Saheli</span> button, and she'll greet you on WhatsApp.
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:30px 40px 0 40px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border-radius:18px;">
                      <tr>
                        <td style="padding:22px 22px 8px 22px;">
                          <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.accentText};padding:0 0 14px 0;">What Saheli does</div>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            ${point("Medicine reminders that get answered", "On WhatsApp, at the right time, in the language your family speaks.")}
                            ${point("A daily check-in", "A warm chat every day, and a word to you if something seems off.")}
                            ${point("Orders and rides, always asked first", "Medicines, groceries or a cab, confirmed with you before anything is placed.")}
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="k-pad" style="padding:24px 40px 32px 40px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.ink2};">
                    Your personal link works once and stays valid for ${days} days. It's yours alone, so please don't forward this email.
                    You can also simply sign in at the dashboard with this email address.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 24px 0 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.ink3};">
              Kavach Care &middot; care for the people who cared for us<br>
              You're getting this because you joined the Kavach waitlist.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
        first ? `${first}, your place on Kavach is ready.` : "Your place on Kavach is ready.",
        "",
        "Thank you for waiting. Saheli, our care companion, is ready to meet you and the people you look after.",
        "Complete your sign-up on the web and she'll get to know your family in a short chat.",
        "",
        "Complete your sign-up:",
        input.registerUrl,
        "",
        "It takes a few minutes. At the end of setup you'll get a \"Send hi to Saheli\" button, and she'll greet you on WhatsApp.",
        "",
        `Your personal link works once and stays valid for ${days} days. Please don't forward this email.`,
        "You can also sign in at the dashboard with this email address.",
        "",
        "Kavach Care",
    ].join("\n");

    return { subject, html, text };
}
