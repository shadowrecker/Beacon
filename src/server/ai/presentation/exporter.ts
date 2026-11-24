/**
 * Deck renderers: PPTX (pptxgenjs) and PDF (pdfkit: pure JS, no headless browser).
 *
 * Both take already-validated slides; the theme color goes through
 * safeThemeColor() again so nothing but a #RRGGBB value ever reaches a renderer.
 * There is no HTML export, so slide text is never interpolated into markup.
 */
import PptxGenJS from "pptxgenjs";
import PDFDocument from "pdfkit";
import { safeThemeColor, type Slide } from "./schema";

export interface RenderInput {
  title: string;
  themeColor: string;
  slides: Slide[];
}

const TEXT = "1F2937";
const MUTED = "6B7280";

/** Readable text color (black or white) on a background hex color. */
export function contrastText(hex: string): string {
  const h = safeThemeColor(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.5 ? "111827" : "FFFFFF";
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

export async function renderPptx(input: RenderInput): Promise<Buffer> {
  const color = safeThemeColor(input.themeColor).slice(1);
  const onColor = contrastText(input.themeColor);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9"; // 10 x 5.625 in
  pptx.title = input.title.slice(0, 200);
  pptx.author = "Beacon";
  pptx.company = "Beacon";

  input.slides.forEach((slide, idx) => {
    const s = pptx.addSlide();
    const hero = slide.layout === "title" || slide.layout === "section";
    if (hero) {
      s.background = { color };
      s.addText(slide.title, {
        x: 0.6, y: 1.6, w: 8.8, h: 1.4, fontSize: slide.layout === "title" ? 40 : 32, bold: true,
        color: onColor, align: "center", valign: "middle", fontFace: "Arial", fit: "shrink",
      });
      if (slide.subtitle) {
        s.addText(slide.subtitle, { x: 0.6, y: 3.1, w: 8.8, h: 0.8, fontSize: 18, color: onColor, align: "center", fontFace: "Arial", fit: "shrink" });
      }
      if (slide.bulletPoints.length) {
        s.addText(slide.bulletPoints.join("  ·  "), { x: 0.6, y: 4.0, w: 8.8, h: 0.8, fontSize: 12, color: onColor, align: "center", fontFace: "Arial", fit: "shrink" });
      }
    } else {
      s.background = { color: "FFFFFF" };
      s.addShape("rect", { x: 0, y: 0, w: 10, h: 0.9, fill: { color }, line: { color, width: 0 } });
      s.addText(slide.title, { x: 0.5, y: 0.1, w: 9, h: 0.7, fontSize: 24, bold: true, color: onColor, valign: "middle", fontFace: "Arial", fit: "shrink" });
      let y = 1.1;
      if (slide.subtitle) {
        s.addText(slide.subtitle, { x: 0.5, y, w: 9, h: 0.5, fontSize: 16, bold: true, color: TEXT, fontFace: "Arial", fit: "shrink" });
        y += 0.6;
      }
      if (slide.bulletPoints.length) {
        s.addText(
          slide.bulletPoints.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
          { x: 0.6, y, w: 8.8, h: 5.0 - y, fontSize: 16, color: TEXT, valign: "top", fontFace: "Arial", paraSpaceAfter: 6, fit: "shrink" }
        );
      }
    }
    s.addText(String(idx + 1), { x: 9.1, y: 5.2, w: 0.6, h: 0.3, fontSize: 10, color: hero ? onColor : MUTED, align: "right", fontFace: "Arial" });
    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
  });

  const out = await pptx.write({ outputType: "nodebuffer" });
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof Uint8Array) return Buffer.from(out);
  if (out instanceof ArrayBuffer) return Buffer.from(new Uint8Array(out));
  throw new Error("PPTX rendering produced an unexpected output type");
}

// ---------------------------------------------------------------------------
// PDF (16:9 pages, 960 x 540 pt)
// ---------------------------------------------------------------------------

const W = 960;
const H = 540;

export function renderPdf(input: RenderInput): Promise<Buffer> {
  const color = safeThemeColor(input.themeColor);
  const onColor = `#${contrastText(input.themeColor)}`;
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [W, H],
      margin: 0,
      autoFirstPage: false,
      info: { Title: input.title.slice(0, 200), Author: "Beacon", Creator: "Beacon" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      input.slides.forEach((slide, idx) => {
        doc.addPage({ size: [W, H], margin: 0 });
        const hero = slide.layout === "title" || slide.layout === "section";
        if (hero) {
          doc.rect(0, 0, W, H).fill(color);
          doc.fillColor(onColor).font("Helvetica-Bold").fontSize(slide.layout === "title" ? 40 : 32);
          doc.text(slide.title, 60, 170, { width: W - 120, align: "center", height: 130, ellipsis: true });
          if (slide.subtitle) {
            doc.font("Helvetica").fontSize(20).text(slide.subtitle, 60, 310, { width: W - 120, align: "center", height: 60, ellipsis: true });
          }
          if (slide.bulletPoints.length) {
            doc.font("Helvetica").fontSize(13).text(slide.bulletPoints.join("  ·  "), 60, 390, { width: W - 120, align: "center", height: 60, ellipsis: true });
          }
        } else {
          doc.rect(0, 0, W, 80).fill(color);
          doc.fillColor(onColor).font("Helvetica-Bold").fontSize(24).text(slide.title, 48, 26, { width: W - 96, height: 36, ellipsis: true, lineBreak: false });
          let y = 110;
          if (slide.subtitle) {
            doc.fillColor(`#${TEXT}`).font("Helvetica-Bold").fontSize(16).text(slide.subtitle, 48, y, { width: W - 96, height: 40, ellipsis: true });
            y = doc.y + 14;
          }
          doc.font("Helvetica").fontSize(15).fillColor(`#${TEXT}`);
          for (const b of slide.bulletPoints) {
            if (y > H - 70) break;
            doc.circle(60, y + 8, 3).fill(color);
            doc.fillColor(`#${TEXT}`).text(b, 74, y, { width: W - 130, height: H - 60 - y, ellipsis: true });
            y = doc.y + 10;
          }
        }
        doc.fillColor(hero ? onColor : `#${MUTED}`).font("Helvetica").fontSize(10).text(String(idx + 1), W - 80, H - 30, { width: 40, align: "right", lineBreak: false });
      });
      if (input.slides.length === 0) doc.addPage({ size: [W, H], margin: 0 });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
