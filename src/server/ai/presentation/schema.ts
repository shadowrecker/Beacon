/**
 * Slide and deck schemas shared by the generator, the router (updateSlide) and
 * the PPTX/PDF renderers, plus theme color validation.
 *
 * Presentation.slidesData (version 1):
 *   { version, title, templateId, revision, rendered: { pptx, pdf } | null,
 *     generatedAt, slides: Slide[] }
 * `revision` increments on every slide edit; `rendered` records which revision
 * the stored PPTX/PDF objects were rendered from, so exports re-render on
 * demand when the slides changed.
 */
import { z } from "zod";

export const THEME_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const DEFAULT_THEME_COLOR = "#3B82F6";

export const themeColorSchema = z.string().regex(THEME_COLOR_RE, "Theme color must be a hex color like #3B82F6");

/** A validated #RRGGBB color (defense in depth for every renderer). */
export function safeThemeColor(value: unknown): string {
  return typeof value === "string" && THEME_COLOR_RE.test(value) ? value.toUpperCase() : DEFAULT_THEME_COLOR;
}

export const SLIDE_LAYOUTS = ["title", "section", "content", "conclusion"] as const;
export const MAX_SLIDES = 30;
export const MAX_BULLETS = 8;

export const slideSchema = z.object({
  slideNumber: z.number().int().min(1).max(MAX_SLIDES),
  layout: z.enum(SLIDE_LAYOUTS),
  title: z.string().trim().min(1, "Slide title is required").max(200),
  subtitle: z.string().trim().max(300),
  bulletPoints: z.array(z.string().trim().min(1).max(300)).max(MAX_BULLETS),
  speakerNotes: z.string().trim().max(3_000),
});
export type Slide = z.infer<typeof slideSchema>;

export const slidesDataSchema = z.object({
  version: z.literal(1),
  title: z.string().max(200),
  templateId: z.string().max(100).nullable(),
  revision: z.number().int().min(0),
  rendered: z.object({ pptx: z.number().int(), pdf: z.number().int() }).nullable(),
  generatedAt: z.string().nullable(),
  slides: z.array(slideSchema).max(MAX_SLIDES),
});
export type SlidesData = z.infer<typeof slidesDataSchema>;

/** Editable slide fields accepted by presentation.updateSlide. */
export const slideEditSchema = z.object({
  title: z.string().trim().min(1, "Slide title is required").max(200),
  subtitle: z.string().trim().max(300).default(""),
  bulletPoints: z
    .array(z.string().trim().max(300))
    .max(MAX_BULLETS, `At most ${MAX_BULLETS} bullet points`)
    .transform((b) => b.filter((x) => x.length > 0)),
  speakerNotes: z.string().trim().max(3_000).default(""),
  layout: z.enum(SLIDE_LAYOUTS).optional(),
});

export function emptySlidesData(templateId: string | null, title: string): SlidesData {
  return { version: 1, title: title.slice(0, 200), templateId, revision: 0, rendered: null, generatedAt: null, slides: [] };
}

/** Parse stored slidesData; invalid or legacy shapes become an empty deck. */
export function readSlidesData(raw: unknown, fallbackTitle: string): SlidesData {
  const parsed = slidesDataSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const templateId =
    raw && typeof raw === "object" && typeof (raw as { templateId?: unknown }).templateId === "string"
      ? ((raw as { templateId: string }).templateId.slice(0, 100))
      : null;
  return emptySlidesData(templateId, fallbackTitle);
}

function cut(text: string, max: number): string {
  const t = text.replace(/\u0000/g, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Normalize loosely-shaped slides (e.g. model output) into valid slides. */
export function normalizeSlides(
  raw: Array<{ title?: string; subtitle?: string; bulletPoints?: string[]; speakerNotes?: string; layout?: string }>
): Slide[] {
  return raw
    .filter((s) => typeof s.title === "string" && s.title.trim().length > 0)
    .slice(0, MAX_SLIDES)
    .map((s, i) => ({
      slideNumber: i + 1,
      layout: (SLIDE_LAYOUTS as readonly string[]).includes(s.layout ?? "")
        ? (s.layout as Slide["layout"])
        : i === 0
          ? "title"
          : "content",
      title: cut(s.title!.replace(/\s+/g, " "), 200),
      subtitle: cut((s.subtitle ?? "").replace(/\s+/g, " "), 300),
      bulletPoints: (s.bulletPoints ?? [])
        .map((b) => cut(String(b).replace(/\s+/g, " "), 300))
        .filter((b) => b.length > 0)
        .slice(0, MAX_BULLETS),
      speakerNotes: cut(s.speakerNotes ?? "", 3_000),
    }));
}
