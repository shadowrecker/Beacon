import Link from "next/link";
import { Quote } from "lucide-react";

export interface CitationView {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  quote: string;
  /** Passage ordinal; when present the link opens the document at that passage. */
  position?: number;
}

/** Verified citations; each opens the cited passage in its document. */
export function CitationList({ projectId, citations }: { projectId: string; citations: CitationView[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sources</p>
      <ol className="space-y-2">
        {citations.map((c, i) => (
          <li key={`${c.chunkId}-${i}`}>
            <Link
              href={`/projects/${projectId}/documents/${c.documentId}${typeof c.position === "number" ? `?chunk=${c.position}` : ""}`}
              className="group block rounded-md border bg-white p-3 text-sm transition-colors hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-950"
            >
              <span className="flex gap-2">
                <Quote className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
                <span className="italic">&ldquo;{c.quote}&rdquo;</span>
              </span>
              <span className="mt-1 block text-xs text-muted-foreground group-hover:text-blue-600 dark:group-hover:text-blue-400">
                {c.documentTitle}
                {typeof c.position === "number" ? ` · passage ${c.position + 1}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
