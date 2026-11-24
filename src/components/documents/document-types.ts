/** Labels and defaults for document types (semantic kind, not file format). */
import { allowedTypeForFilename, extensionOf } from "@/lib/file-types";

export const DOCUMENT_TYPES = [
  { value: "TRANSCRIPT", label: "Interview or call transcript" },
  { value: "SUPPORT_TICKET", label: "Support tickets" },
  { value: "NOTE", label: "Notes" },
  { value: "CALL_RECORDING", label: "Call recording" },
  { value: "OTHER", label: "Other" },
] as const;

export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number]["value"];

export const DOCUMENT_TYPE_LABEL: Record<DocumentTypeValue, string> = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t.value, t.label])) as Record<
  DocumentTypeValue,
  string
>;

/** A sensible default type for a file, from its extension. */
export function defaultTypeFor(filename: string): DocumentTypeValue {
  const allowed = allowedTypeForFilename(filename);
  if (allowed && allowed.category !== "document") return "CALL_RECORDING";
  const ext = extensionOf(filename);
  if (ext === "vtt" || ext === "srt") return "TRANSCRIPT";
  return "OTHER";
}
