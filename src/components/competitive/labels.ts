import type { BadgeProps } from "@/components/ui/badge";

export const UPDATE_TYPES = ["CHANGELOG", "FEATURE", "PRICING", "PRESS", "REVIEW"] as const;
export type UpdateType = (typeof UPDATE_TYPES)[number];

export const UPDATE_TYPE_LABEL: Record<UpdateType, string> = {
  CHANGELOG: "Changelog",
  FEATURE: "Feature",
  PRICING: "Pricing",
  PRESS: "News",
  REVIEW: "Review insight",
};

export const SENTIMENTS = ["POSITIVE", "NEUTRAL", "MIXED", "NEGATIVE"] as const;
export type SentimentValue = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABEL: Record<SentimentValue, string> = {
  POSITIVE: "Positive",
  NEUTRAL: "Neutral",
  MIXED: "Mixed",
  NEGATIVE: "Negative",
};

export const SENTIMENT_VARIANT: Record<SentimentValue, BadgeProps["variant"]> = {
  POSITIVE: "positive",
  NEUTRAL: "neutral",
  MIXED: "medium",
  NEGATIVE: "negative",
};

export const ALERT_TYPE_LABEL: Record<string, string> = {
  PRICING_CHANGE: "Pricing change",
  PRODUCT_UPDATE: "Product update",
  ANNOUNCEMENT: "Announcement",
};
