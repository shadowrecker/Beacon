/**
 * Notification preferences (User.notificationPrefs).
 *
 * In-app notifications are always delivered; the preference is the
 * email channel per NotificationType, stored as {"TYPE": {"email": boolean}}.
 * Email defaults come from `notify()` (src/server/notifications/notify.ts).
 */
import { NotificationType } from "@prisma/client";
import { z } from "zod";
import { EMAIL_BY_DEFAULT } from "@/server/notifications/notify";

export const NOTIFICATION_TYPES = Object.values(NotificationType) as NotificationType[];

/** Single source of truth: the defaults `notify()` applies. */
export const EMAIL_DEFAULT_TYPES = EMAIL_BY_DEFAULT;

export const notificationTypeSchema = z.enum(NotificationType);

/** Input schema: any subset of types, each with an explicit email flag. */
export const notificationPrefsSchema = z.partialRecord(
  notificationTypeSchema,
  z.object({ email: z.boolean() }).strict()
);

export type NotificationPrefs = Partial<Record<NotificationType, { email: boolean }>>;
export type EffectivePrefs = Record<NotificationType, { email: boolean }>;

/** Parse a stored value leniently (unknown keys and malformed entries are dropped). */
export function parseStoredPrefs(raw: unknown): NotificationPrefs {
  const out: NotificationPrefs = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const type of NOTIFICATION_TYPES) {
    const entry = (raw as Record<string, unknown>)[type];
    if (entry && typeof entry === "object" && typeof (entry as { email?: unknown }).email === "boolean") {
      out[type] = { email: (entry as { email: boolean }).email };
    }
  }
  return out;
}

/** Every type with its effective email setting (explicit value or default). */
export function effectivePrefs(raw: unknown): EffectivePrefs {
  const stored = parseStoredPrefs(raw);
  return Object.fromEntries(
    NOTIFICATION_TYPES.map((t) => [t, { email: stored[t]?.email ?? EMAIL_DEFAULT_TYPES.has(t) }])
  ) as EffectivePrefs;
}

/** Merge an update into the stored value; the result has explicit values only. */
export function mergePrefs(raw: unknown, update: NotificationPrefs): NotificationPrefs {
  return { ...parseStoredPrefs(raw), ...update };
}
