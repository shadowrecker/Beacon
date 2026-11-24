/** Display labels and badge variants for roadmap enums. */
import type { BadgeProps } from "@/components/ui/badge";

export const ITEM_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type ItemPriority = (typeof ITEM_PRIORITIES)[number];

export const STATUS_LABEL: Record<ItemStatus, string> = {
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const STATUS_VARIANT: Record<ItemStatus, NonNullable<BadgeProps["variant"]>> = {
  PLANNED: "secondary",
  IN_PROGRESS: "low",
  COMPLETED: "positive",
  CANCELLED: "outline",
};

export const PRIORITY_LABEL: Record<ItemPriority, string> = {
  P0: "P0 · Urgent",
  P1: "P1 · High",
  P2: "P2 · Medium",
  P3: "P3 · Low",
};

export const PRIORITY_VARIANT: Record<ItemPriority, NonNullable<BadgeProps["variant"]>> = {
  P0: "high",
  P1: "medium",
  P2: "secondary",
  P3: "outline",
};

export const SOURCE_LABEL: Record<string, string> = {
  MANUAL: "Manual",
  CSV: "CSV",
  LINEAR: "Linear",
  JIRA: "Jira",
  NOTION: "Notion",
  PRODUCTBOARD: "Productboard",
};

export const SENTIMENT_VARIANT: Record<string, NonNullable<BadgeProps["variant"]>> = {
  POSITIVE: "positive",
  NEGATIVE: "negative",
  NEUTRAL: "neutral",
  MIXED: "medium",
};
