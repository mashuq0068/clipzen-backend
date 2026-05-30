/* eslint-disable no-undef */
/**
 * Email service — Resend.
 *
 * Why Resend: free tier is 3,000 emails/mo (100/day), instant delivery, no card
 * required, and works out of the box with the `onboarding@resend.dev` sender
 * for development. For production, verify your domain in the Resend dashboard
 * and set EMAIL_FROM to a `noreply@clipzen.ai` address.
 *
 * Required env:
 *   RESEND_API_KEY     re_xxx... from https://resend.com/api-keys
 *   EMAIL_FROM         "Clipzen <onboarding@resend.dev>" for dev,
 *                      "Clipzen <noreply@clipzen.ai>" for prod after domain verify
 *   FRONTEND_URL       used to build verify/reset links
 *   LOGO_URL           public URL of the Clipzen logo (defaults below)
 */

const { Resend } = require("resend");

const FROM =
  process.env.EMAIL_FROM || "Clipzen <onboarding@resend.dev>";
const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:8080";
const LOGO_URL =
  process.env.LOGO_URL ||
  "https://raw.githubusercontent.com/clipzen-ai/brand/main/logo.png"; // fallback

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      "RESEND_API_KEY is not set. Create one at https://resend.com/api-keys",
    );
  }
  resendClient = new Resend(key);
  return resendClient;
}

// ── Shared HTML wrapper ─────────────────────────────────────────
// Inline styles only — most email clients strip <style> tags.
function emailShell({ preheader, title, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f3f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#1a1a1a;">
    <!-- preheader (hidden) -->
    <div style="display:none;max-height:0;overflow:hidden;color:#f6f3f1;opacity:0;">
      ${preheader}
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f3f1;">
      <tr>
        <td align="center" style="padding:40px 20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:20px;border:1px solid #efe6e2;overflow:hidden;">
            <!-- logo / header -->
            <tr>
              <td style="padding:32px 36px 0 36px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${LOGO_URL}" alt="Clipzen" width="44" height="44" style="display:block;border-radius:10px;" />
                    </td>
                    <td style="vertical-align:middle;padding-left:12px;font-size:18px;font-weight:600;color:#1a1a1a;letter-spacing:-0.01em;">
                      Clipzen
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- body -->
            <tr>
              <td style="padding:28px 36px 36px 36px;">
                ${body}
              </td>
            </tr>

            <!-- footer -->
            <tr>
              <td style="padding:24px 36px;border-top:1px solid #efe6e2;background:#fafafa;font-size:12px;color:#8a8a8a;line-height:1.6;">
                Sent by Clipzen · The AI clip editor for creators.<br/>
                If you didn't request this, you can safely ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function signature() {
  return `
    <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#3a3a3a;">
      Cheers,<br/>
      <strong>Mashuq</strong> · Founder, Clipzen
    </p>
  `;
}

// ── Templates ───────────────────────────────────────────────────

function verifyEmailTemplate({ name, code }) {
  const safeName = (name || "there").trim() || "there";
  const body = `
    <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:600;color:#1a1a1a;letter-spacing:-0.01em;">
      Verify your email
    </h1>
    <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#3a3a3a;">
      Hi <strong>${safeName}</strong>, I'm <strong>Mashuq from Clipzen</strong>. I just want to make sure this email really belongs to you.
    </p>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#3a3a3a;">
      Drop the 6-digit code below into the Clipzen verify screen — it expires in 15 minutes.
    </p>

    <div style="margin:0 0 24px 0;padding:18px 22px;background:#fff5fa;border:1px solid #f8c7e0;border-radius:14px;text-align:center;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#a0246c;">
        Your verification code
      </div>
      <div style="margin-top:6px;font-size:34px;font-weight:700;letter-spacing:0.32em;color:#d6336c;font-family:'SF Mono','Monaco',Consolas,monospace;">
        ${code}
      </div>
    </div>

    <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#6a6a6a;">
      If you didn't create a Clipzen account, just ignore this — no account will be created without verification.
    </p>
    ${signature()}
  `;
  return {
    subject: "Verify your Clipzen email",
    html: emailShell({
      preheader: `Your Clipzen verification code is ${code}`,
      title: "Verify your Clipzen email",
      body,
    }),
    text: `Hi ${safeName},

I'm Mashuq from Clipzen. Please verify your email with the 6-digit code below — it expires in 15 minutes.

Code: ${code}

If you didn't create a Clipzen account, ignore this email.

— Mashuq, Founder of Clipzen`,
  };
}

function resetPasswordTemplate({ name, resetUrl }) {
  const safeName = (name || "there").trim() || "there";
  const body = `
    <h1 style="margin:0 0 12px 0;font-size:24px;font-weight:600;color:#1a1a1a;letter-spacing:-0.01em;">
      Reset your password
    </h1>
    <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#3a3a3a;">
      Hi <strong>${safeName}</strong>, <strong>Mashuq from Clipzen</strong> here. We got a request to reset your password.
    </p>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#3a3a3a;">
      Click the button below to choose a new one — the link is valid for 30 minutes.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:999px;background:#d6336c;">
          <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">
            Reset password
          </a>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 6px 0;font-size:13px;line-height:1.6;color:#6a6a6a;">
      Button not working? Paste this URL into your browser:
    </p>
    <p style="margin:0 0 16px 0;font-size:12px;line-height:1.6;color:#8a8a8a;word-break:break-all;">
      ${resetUrl}
    </p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#6a6a6a;">
      If you didn't request a reset, ignore this email — your password stays as it is.
    </p>
    ${signature()}
  `;
  return {
    subject: "Reset your Clipzen password",
    html: emailShell({
      preheader: "Reset your Clipzen password — link valid for 30 minutes",
      title: "Reset your Clipzen password",
      body,
    }),
    text: `Hi ${safeName},

I'm Mashuq from Clipzen. Click the link below to reset your password — it's valid for 30 minutes.

${resetUrl}

If you didn't request this, ignore this email.

— Mashuq, Founder of Clipzen`,
  };
}

// ── Sender API ──────────────────────────────────────────────────

async function sendVerificationEmail({ to, name, code }) {
  const { subject, html, text } = verifyEmailTemplate({ name, code });
  const { data, error } = await getResend().emails.send({
    from: FROM,
    to,
    subject,
    html,
    text,
  });
  if (error) {
    console.error("[email] verification send failed:", error);
    throw new Error(error.message || "Failed to send verification email");
  }
  return data;
}

async function sendPasswordResetEmail({ to, name, token }) {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const { subject, html, text } = resetPasswordTemplate({ name, resetUrl });
  const { data, error } = await getResend().emails.send({
    from: FROM,
    to,
    subject,
    html,
    text,
  });
  if (error) {
    console.error("[email] reset send failed:", error);
    throw new Error(error.message || "Failed to send reset email");
  }
  return data;
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
};
