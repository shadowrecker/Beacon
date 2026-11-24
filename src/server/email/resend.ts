/**
 * Email delivery through Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email).
 *
 * The destination is fixed (api.resend.com), so this is not a user-influenced
 * fetch. Errors carry the HTTP status so the job runner can tell permanent
 * (4xx) from transient (429/5xx/network) failures.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend de-duplicates sends with the same key for 24h. */
  idempotencyKey: string;
  headers?: Record<string, string>;
}

export interface EmailConfig {
  apiKey: string | undefined;
  from: string;
  appUrl: string;
  isProduction: boolean;
}

export function emailConfig(): EmailConfig {
  return {
    apiKey: process.env.RESEND_API_KEY || undefined,
    from: process.env.EMAIL_FROM || "Beacon <notifications@localhost>",
    appUrl: process.env.APP_URL || "http://localhost:3000",
    isProduction: process.env.NODE_ENV === "production",
  };
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

/** Send one email. Returns Resend's message id. */
export async function sendWithResend(apiKey: string, from: string, email: OutgoingEmail): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": email.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network error or timeout: transient, retried by the queue policy.
    throw new EmailSendError(`Email provider unreachable: ${err instanceof Error ? err.name : "error"}`);
  }

  if (!res.ok) {
    // Resend error bodies are {name, message}; keep only the short name.
    let name = "";
    try {
      const body = (await res.json()) as { name?: unknown };
      name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
    } catch {
      // ignore unparsable bodies
    }
    throw new EmailSendError(`Email provider rejected the message (HTTP ${res.status}${name ? `, ${name}` : ""})`, res.status);
  }

  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" ? body.id : null;
  } catch {
    return null;
  }
}
