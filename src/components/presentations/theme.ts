/**
 * Presentation constants and theme-color helpers for the UI.
 *
 * Theme colors are validated (#RRGGBB) before they are ever applied to a style,
 * mirroring the server-side validation in the presentation router.
 */
import type { RouterOutputs } from "@/lib/trpc";

export type PresentationDetail = RouterOutputs["presentation"]["get"];
export type Slide = PresentationDetail["slides"][number];
export type SlideLayout = Slide["layout"];
export type PresentationListItem = RouterOutputs["presentation"]["list"]["items"][number];
export type PresentationTemplate = RouterOutputs["presentation"]["listTemplates"][number];
export type Audience = PresentationDetail["audience"];
export type PresentationType = PresentationDetail["type"];
export type PresentationStatus = PresentationDetail["status"];

export const THEME_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const DEFAULT_THEME_COLOR = "#3B82F6";

export function isValidThemeColor(value: string): boolean {
  return THEME_COLOR_RE.test(value);
}

/** A validated #RRGGBB color, or the default. */
export function safeThemeColor(value: string | null | undefined): string {
  return value && THEME_COLOR_RE.test(value) ? value.toUpperCase() : DEFAULT_THEME_COLOR;
}

/** Readable text color (near-black or white) on top of a background color. */
export function contrastText(hex: string): string {
  const h = safeThemeColor(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "#111827" : "#FFFFFF";
}

export const AUDIENCE_OPTIONS: Array<{ value: Audience; label: string; description: string }> = [
  { value: "EXECUTIVE", label: "Executive", description: "Leadership: impact, priorities and decisions" },
  { value: "ENGINEERING", label: "Engineering", description: "Engineering teams: scope and sequencing" },
  { value: "CUSTOMER", label: "Customer", description: "Customers: what we heard and what changes" },
  { value: "BOARD", label: "Board", description: "Board members: strategy, risk and outcomes" },
  { value: "SALES", label: "Sales", description: "Sales teams: pain points and talking points" },
  { value: "INVESTOR", label: "Investor", description: "Investors: demand signals and traction" },
];

export const TYPE_OPTIONS: Array<{ value: PresentationType; label: string; description: string }> = [
  { value: "SYNTHESIS_READOUT", label: "Synthesis readout", description: "Present what customers said" },
  { value: "RECOMMENDATION_PITCH", label: "Recommendation pitch", description: "Pitch the top recommendations" },
  { value: "QBR", label: "Quarterly review", description: "Feedback, decisions and outcomes this quarter" },
  { value: "LAUNCH_BRIEF", label: "Launch brief", description: "Connect shipped work to customer evidence" },
  { value: "CUSTOM", label: "Stakeholder update", description: "A general update" },
];

export const LAYOUT_OPTIONS: Array<{ value: SlideLayout; label: string }> = [
  { value: "title", label: "Title" },
  { value: "section", label: "Section divider" },
  { value: "content", label: "Content" },
  { value: "conclusion", label: "Conclusion" },
];

export function audienceLabel(a: Audience): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === a)?.label ?? a;
}

export function typeLabel(t: PresentationType): string {
  return TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;
}
