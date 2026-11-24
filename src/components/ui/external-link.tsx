"use client";

/**
 * Links to user- or third-party-supplied URLs. Only absolute http(s) URLs are
 * rendered as links (javascript:, data: and other schemes are shown as plain
 * text), and they always open in a new tab without an opener or referrer.
 */
import type { ReactNode } from "react";
import { ExternalLink as ExternalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function ExternalLink({ href, children, className }: { href: string | null | undefined; children?: ReactNode; className?: string }) {
  const safe = safeHref(href);
  const label = children ?? href ?? "";
  if (!safe) return <span className={cn("break-all text-muted-foreground", className)}>{label}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      className={cn("inline-flex items-center gap-1 break-all text-blue-600 underline-offset-2 hover:underline dark:text-blue-400", className)}
    >
      {label}
      <ExternalIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
