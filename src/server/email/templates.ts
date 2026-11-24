/**
 * Transactional email templates (QUEUE.EMAIL `template` values).
 *
 * Every interpolated value is HTML-escaped; links are only rendered when they
 * point at this app (APP_URL origin), so job data can never inject markup or
 * send recipients elsewhere. Each email has a plain-text alternative and a link
 * to the notification preferences in /settings.
 */
import { z } from "zod";

export type EmailTemplate = "org-invite" | "mention" | "notification";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Preferences URL, also used for the List-Unsubscribe header. */
  preferencesUrl: string;
}

export class TemplateDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateDataError";
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

/** Single line, no control characters, bounded (subjects and inline values). */
function oneLine(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Multi-line text with control characters (except newlines) removed, bounded. */
function block(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function appOrigin(appUrl: string): string {
  return new URL(appUrl).origin;
}

/**
 * Resolve a link for an email: relative app paths ("/projects/x") become absolute,
 * absolute URLs are accepted only on the app's origin. Anything else -> null.
 */
export function resolveAppLink(href: string | null | undefined, appUrl: string): string | null {
  if (!href) return null;
  const origin = appOrigin(appUrl);
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\")) {
    try {
      const url = new URL(href, origin);
      return url.origin === origin ? url.toString() : null;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(href);
    return url.origin === origin && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : null;
  } catch {
    return null;
  }
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: "an owner",
  ADMIN: "an admin",
  MEMBER: "a member",
  VIEWER: "a viewer",
};

const inviteData = z.object({
  orgName: z.string().min(1).max(200),
  inviterName: z.string().min(1).max(200),
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]),
  acceptUrl: z.string().min(1).max(2000),
  expiresAt: z.string().datetime(),
});

const messageData = z.object({
  title: z.string().min(1).max(500),
  message: z.string().max(5000).default(""),
  href: z.string().max(2000).nullable().optional(),
});

function parse<T extends z.ZodType>(schema: T, data: unknown, template: EmailTemplate): z.infer<T> {
  const res = schema.safeParse(data);
  if (!res.success) throw new TemplateDataError(`Invalid data for email template "${template}"`);
  return res.data;
}

function paragraphsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function layout(opts: { heading: string; bodyHtml: string; cta?: { label: string; url: string }; footerHtml: string }): string {
  const button = opts.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.cta.url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escapeHtml(opts.cta.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#6b7280">Or open this link: <a href="${escapeHtml(opts.cta.url)}" style="color:#2563eb">${escapeHtml(opts.cta.url)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px">
<tr><td>
<p style="margin:0 0 24px;font-size:18px;font-weight:700;color:#111827">Beacon</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(opts.heading)}</h1>
${opts.bodyHtml}
${button}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
<div style="font-size:12px;color:#6b7280;line-height:1.5">${opts.footerHtml}</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Render a template. Throws TemplateDataError when `data` doesn't match it. */
export function renderEmail(template: EmailTemplate, data: unknown, appUrl: string): RenderedEmail {
  const preferencesUrl = `${appOrigin(appUrl)}/settings#notifications`;
  const prefsFooterHtml = `You can change which emails you receive in your <a href="${escapeHtml(preferencesUrl)}" style="color:#6b7280">notification preferences</a>.`;
  const prefsFooterText = `Change which emails you receive: ${preferencesUrl}`;

  if (template === "org-invite") {
    const d = parse(inviteData, data, template);
    const acceptUrl = resolveAppLink(d.acceptUrl, appUrl);
    if (!acceptUrl) throw new TemplateDataError("Invitation link must point at this app");
    const orgName = oneLine(d.orgName, 120);
    const inviterName = oneLine(d.inviterName, 120);
    const roleLabel = ROLE_LABELS[d.role];
    const expires = new Date(d.expiresAt).toUTCString();
    const subject = oneLine(`${inviterName} invited you to join ${orgName} on Beacon`, 200);
    const intro = `${inviterName} invited you to join ${orgName} on Beacon as ${roleLabel}.`;
    const how = "Sign in (or create an account) with this email address to accept the invitation.";
    const expiry = `This invitation expires on ${expires}.`;
    const ignore = "If you weren't expecting this invitation, you can ignore this email.";
    const html = layout({
      heading: `Join ${orgName} on Beacon`,
      bodyHtml: paragraphsHtml(`${intro}\n\n${how}`),
      cta: { label: "Accept invitation", url: acceptUrl },
      footerHtml: `${escapeHtml(expiry)} ${escapeHtml(ignore)}<br>${prefsFooterHtml}`,
    });
    const text = [
      `Join ${orgName} on Beacon`,
      "",
      intro,
      how,
      "",
      `Accept the invitation: ${acceptUrl}`,
      "",
      expiry,
      ignore,
      "",
      prefsFooterText,
    ].join("\n");
    return { subject, html, text, preferencesUrl };
  }

  const d = parse(messageData, data, template);
  const link = resolveAppLink(d.href ?? null, appUrl);
  const title = oneLine(d.title, 200);
  const message = block(d.message, 4000);
  const subject = template === "mention" ? oneLine(`${title} on Beacon`, 200) : oneLine(title, 200);
  const html = layout({
    heading: title,
    bodyHtml: message ? paragraphsHtml(message) : "",
    cta: link ? { label: "View in Beacon", url: link } : undefined,
    footerHtml: prefsFooterHtml,
  });
  const text = [title, "", message, ...(link ? ["", `View in Beacon: ${link}`] : []), "", prefsFooterText]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
  return { subject, html, text, preferencesUrl };
}
