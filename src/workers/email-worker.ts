/**
 * Worker for QUEUE.EMAIL: renders a template and sends it through Resend.
 *
 * - Templates escape every interpolated value and include a plain-text part.
 * - De-duplicated by `dedupeKey`: a delivered key is remembered in Redis, and the
 *   same key is passed to Resend as the Idempotency-Key, so a retried or
 *   re-enqueued job never sends twice.
 * - Without RESEND_API_KEY the send is a logged no-op outside production; in
 *   production it fails permanently so a misconfiguration is visible.
 * - Invalid template data and 4xx provider responses are permanent failures;
 *   429/5xx/network errors are retried by the queue policy.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, NonRetryableError } from "@/server/jobs/worker";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { sha256Hex } from "@/lib/crypto";
import { renderEmail, TemplateDataError } from "@/server/email/templates";
import { emailConfig, sendWithResend } from "@/server/email/resend";

const SENT_TTL_SEC = 7 * 24 * 3600;

export function sentKey(dedupeKey: string): string {
  return `email:sent:${sha256Hex(dedupeKey)}`;
}

function recipientDomain(to: string): string {
  return to.split("@")[1] ?? "unknown";
}

export const emailWorker = defineWorker({
  queue: QUEUE.EMAIL,
  concurrency: 4,
  // Stay well under provider rate limits.
  limiter: { max: 8, duration: 1_000 },
  handler: async (job, ctx) => {
    const config = emailConfig();
    const key = sentKey(job.dedupeKey);
    const redis = getRedis();

    if (await redis.exists(key).catch(() => 0)) {
      ctx.log.info("email already sent; skipping", { template: job.template });
      return { skipped: true };
    }

    let rendered;
    try {
      rendered = renderEmail(job.template, job.data, config.appUrl);
    } catch (err) {
      if (err instanceof TemplateDataError) throw new NonRetryableError(err.message);
      throw err;
    }

    if (!config.apiKey) {
      if (config.isProduction) {
        throw new NonRetryableError("Email delivery is not configured (RESEND_API_KEY is unset)");
      }
      ctx.log.info("email delivery disabled (no RESEND_API_KEY); not sent", {
        template: job.template,
        recipientDomain: recipientDomain(job.to),
      });
      return { sent: false, reason: "not-configured" };
    }

    const providerId = await sendWithResend(config.apiKey, config.from, {
      to: job.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: sha256Hex(job.dedupeKey),
      headers: { "List-Unsubscribe": `<${rendered.preferencesUrl}>` },
    });

    await redis.set(key, providerId ?? "1", "EX", SENT_TTL_SEC).catch((err) => {
      // Resend's idempotency key still protects the next 24h.
      ctx.log.warn("could not record sent email", { err });
    });
    ctx.log.info("email sent", { template: job.template, recipientDomain: recipientDomain(job.to), providerId });
    return { sent: true, providerId };
  },
  onFinalFailure: async (job, error) => {
    // Email has no owning row; the failure is logged for operators.
    logger.error("email permanently failed", { template: job.template, recipientDomain: recipientDomain(job.to), err: error });
  },
});
