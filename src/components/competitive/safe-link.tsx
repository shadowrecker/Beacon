import type { ReactNode } from "react";
import { ExternalLink as ExternalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Returns the URL only when its scheme is http(s). Defense in depth: the server
 * already allowlists schemes, but nothing like `javascript:` ever reaches an href.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function displayHost(raw: string | null | undefined): string | null {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const u = new URL(safe);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname !== "/" ? u.pathname : ""}`;
}

/** External link that renders as plain text when the URL isn't http(s). */
export function ExternalLink({ href, children, className }: { href: string | null | undefined; children?: ReactNode; className?: string }) {
  const safe = safeHttpUrl(href);
  const label = children ?? displayHost(href) ?? href;
  if (!safe) return <span className={className}>{label}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={cn("inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400", className)}
    >
      <span className="truncate">{label}</span>
      <ExternalIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
