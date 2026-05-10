/**
 * Mailer — Resend-backed transactional email for sign-in / password-reset flows.
 *
 * Required env (from backend/.env):
 *   RESEND_API_KEY      — re_…  (mandatory; sender refuses to operate without it)
 *   ATELIER_MAIL_FROM   — display + address, e.g. "Atelier <noreply@example.com>"
 *   ATELIER_PUBLIC_URL  — origin used to compose magic-link / reset URLs (e.g. https://atelier.example.com)
 *
 * Behaviour when RESEND_API_KEY is missing: send() returns { delivered: false } and the
 * caller is expected to fall back to host-log delivery (the legacy path). This keeps
 * dev installs without an API key working — the link still appears in /tmp/atelier-backend.log.
 */

import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY ?? "";
const from = process.env.ATELIER_MAIL_FROM ?? "Atelier <noreply@example.com>";
const _resend = apiKey ? new Resend(apiKey) : null;

export function isMailerConfigured(): boolean {
  return _resend !== null;
}

export interface SendResult {
  delivered: boolean;
  /** Resend message id if delivered, else a one-line reason. */
  reason: string;
}

async function send(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  if (!_resend) return { delivered: false, reason: "RESEND_API_KEY not set" };
  try {
    const { data, error } = await _resend.emails.send({ from, to, subject, html, text });
    if (error) return { delivered: false, reason: `resend error: ${error.name}: ${error.message}` };
    return { delivered: true, reason: data?.id ?? "(no id)" };
  } catch (e) {
    return { delivered: false, reason: `resend threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function sendMagicLink(to: string, link: string, displayName: string | null): Promise<SendResult> {
  const greeting = displayName ? `Hi ${displayName.split(/\s+/)[0]},` : "Hi,";
  const subject = "Your Atelier sign-in link";
  const text = [
    greeting,
    "",
    "Click the link below to sign in to Atelier. It's good for 15 minutes and one use.",
    "",
    link,
    "",
    "If you didn't ask for this, you can ignore the email — nothing happens until the link is clicked.",
    "",
    "— Atelier",
  ].join("\n");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:520px;margin:0 auto;padding:24px;">
      <p>${escapeHtml(greeting)}</p>
      <p>Click the button below to sign in to Atelier. It's good for 15 minutes and one use.</p>
      <p style="margin:28px 0;">
        <a href="${escapeAttr(link)}"
           style="display:inline-block;padding:12px 22px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
          Sign in to Atelier
        </a>
      </p>
      <p style="color:#666;font-size:13px;">Button not working? Paste this URL into your browser:<br>
        <span style="word-break:break-all;color:#444;">${escapeHtml(link)}</span>
      </p>
      <p style="color:#666;font-size:13px;">If you didn't ask for this, ignore the email — nothing happens until the link is clicked.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="color:#999;font-size:12px;">— Atelier</p>
    </div>
  `;
  return send(to, subject, html, text);
}

export async function sendPasswordResetLink(to: string, link: string, displayName: string | null): Promise<SendResult> {
  const greeting = displayName ? `Hi ${displayName.split(/\s+/)[0]},` : "Hi,";
  const subject = "Reset your Atelier password";
  const text = [
    greeting,
    "",
    "Use the link below to set a new password for your Atelier account. It's good for 30 minutes and one use.",
    "",
    link,
    "",
    "If you didn't request this, you can ignore the email — your password won't change unless the link is clicked.",
    "",
    "— Atelier",
  ].join("\n");
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:520px;margin:0 auto;padding:24px;">
      <p>${escapeHtml(greeting)}</p>
      <p>Use the button below to set a new password for your Atelier account. It's good for 30 minutes and one use.</p>
      <p style="margin:28px 0;">
        <a href="${escapeAttr(link)}"
           style="display:inline-block;padding:12px 22px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
          Reset password
        </a>
      </p>
      <p style="color:#666;font-size:13px;">Button not working? Paste this URL into your browser:<br>
        <span style="word-break:break-all;color:#444;">${escapeHtml(link)}</span>
      </p>
      <p style="color:#666;font-size:13px;">If you didn't request this, ignore the email — your password won't change unless the link is clicked.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="color:#999;font-size:12px;">— Atelier</p>
    </div>
  `;
  return send(to, subject, html, text);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
