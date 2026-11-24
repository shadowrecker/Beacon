/**
 * Rendering decks into object storage.
 *
 * Keys come from projectObjectKey(projectId, "presentations", presentationId, ...)
 * and are what Presentation.pptxUrl / pdfUrl store; downloads are short-lived
 * presigned GET URLs. Objects are only read or deleted after keyBelongsToProject.
 */
import { getStorage, keyBelongsToProject, projectObjectKey } from "@/lib/storage";
import { sanitizeFilename } from "@/lib/file-types";
import { renderPdf, renderPptx } from "./exporter";
import { safeThemeColor, type SlidesData } from "./schema";

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PDF_MIME = "application/pdf";
export type DeckFormat = "pptx" | "pdf";

export function deckKey(projectId: string, presentationId: string, format: DeckFormat): string {
  return projectObjectKey(projectId, "presentations", presentationId, `deck.${format}`);
}

export function downloadName(title: string, format: DeckFormat): string {
  const base = sanitizeFilename(title || "presentation").replace(/\.+$/, "").slice(0, 80) || "presentation";
  return `${base}.${format}`;
}

/** Render the requested formats and upload them; returns the stored keys. */
export async function renderAndStore(
  p: { id: string; projectId: string; title: string; themeColor: string },
  data: SlidesData,
  formats: DeckFormat[]
): Promise<Partial<Record<DeckFormat, string>>> {
  const input = { title: p.title, themeColor: safeThemeColor(p.themeColor), slides: data.slides };
  const storage = getStorage();
  const keys: Partial<Record<DeckFormat, string>> = {};
  for (const format of formats) {
    const key = deckKey(p.projectId, p.id, format);
    const body = format === "pptx" ? await renderPptx(input) : await renderPdf(input);
    await storage.put(key, body, format === "pptx" ? PPTX_MIME : PDF_MIME);
    keys[format] = key;
  }
  return keys;
}

/** Delete a presentation's stored objects (only keys inside the project prefix). */
export async function deleteDeckObjects(projectId: string, presentationId: string, keys: Array<string | null>): Promise<void> {
  const storage = getStorage();
  const all = new Set<string>([deckKey(projectId, presentationId, "pptx"), deckKey(projectId, presentationId, "pdf")]);
  for (const k of keys) if (k) all.add(k);
  for (const key of all) {
    if (keyBelongsToProject(key, projectId)) await storage.delete(key);
  }
}
