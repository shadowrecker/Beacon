/**
 * Renders one slide as a 16:9 preview. Title and section slides are a colored
 * hero; content and conclusion slides have a colored header bar and bullets.
 * The theme color is validated before it is applied to any style.
 */
import { cn } from "@/lib/utils";
import { contrastText, safeThemeColor, type Slide } from "./theme";

export function SlidePreview({
  slide,
  themeColor,
  compact = false,
  className,
}: {
  slide: Slide;
  themeColor: string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const color = safeThemeColor(themeColor);
  const onColor = contrastText(color);
  const hero = slide.layout === "title" || slide.layout === "section";

  if (hero) {
    return (
      <div
        className={cn("relative flex aspect-video w-full flex-col items-center justify-center overflow-hidden rounded-md text-center", compact ? "p-2" : "p-8 md:p-12", className)}
        style={{ backgroundColor: color, color: onColor }}
      >
        <h3 className={cn("font-bold leading-tight", compact ? "line-clamp-2 text-[10px]" : slide.layout === "title" ? "text-2xl md:text-4xl" : "text-xl md:text-3xl")}>
          {slide.title}
        </h3>
        {slide.subtitle && (
          <p className={cn("opacity-90", compact ? "mt-1 line-clamp-1 text-[8px]" : "mt-4 text-base md:text-lg")}>{slide.subtitle}</p>
        )}
        {!compact && slide.bulletPoints.length > 0 && (
          <p className="mt-6 text-sm opacity-80">{slide.bulletPoints.join("  ·  ")}</p>
        )}
        <span className={cn("absolute bottom-1 right-2 opacity-70", compact ? "text-[8px]" : "text-xs")} aria-hidden>
          {slide.slideNumber}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("relative flex aspect-video w-full flex-col overflow-hidden rounded-md border bg-white text-gray-800 dark:border-gray-700", className)}>
      <div className={cn("flex items-center", compact ? "h-[18%] px-2" : "h-[15%] px-6")} style={{ backgroundColor: color, color: onColor }}>
        <h3 className={cn("truncate font-bold", compact ? "text-[9px]" : "text-lg md:text-2xl")}>{slide.title}</h3>
      </div>
      <div className={cn("flex-1 overflow-hidden", compact ? "p-2" : "p-6")}>
        {slide.subtitle && (
          <p className={cn("font-semibold text-gray-900", compact ? "line-clamp-1 text-[8px]" : "mb-3 text-base md:text-lg")}>{slide.subtitle}</p>
        )}
        {slide.bulletPoints.length > 0 && (
          <ul className={cn("list-disc space-y-1 pl-4", compact ? "text-[7px] leading-tight" : "text-sm md:text-base")}>
            {(compact ? slide.bulletPoints.slice(0, 3) : slide.bulletPoints).map((b, i) => (
              <li key={i} className={compact ? "line-clamp-1" : undefined}>
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className={cn("absolute bottom-1 right-2 text-gray-500", compact ? "text-[8px]" : "text-xs")} aria-hidden>
        {slide.slideNumber}
      </span>
    </div>
  );
}

export function SpeakerNotes({ notes }: { notes: string }) {
  return (
    <section aria-labelledby="speaker-notes-heading" className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
      <h4 id="speaker-notes-heading" className="mb-2 text-sm font-semibold text-yellow-900 dark:text-yellow-100">
        Speaker notes
      </h4>
      {notes ? (
        <p className="whitespace-pre-wrap text-sm text-yellow-900 dark:text-yellow-100">{notes}</p>
      ) : (
        <p className="text-sm text-yellow-800/80 dark:text-yellow-200/70">No speaker notes for this slide.</p>
      )}
    </section>
  );
}
