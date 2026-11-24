"use client";

/**
 * Template picker. Each template is a toggle button (aria-pressed); choosing
 * "No template" lets the generator pick an outline. Template colors are
 * validated before being shown as a swatch.
 */
import { Check, LayoutTemplate } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { audienceLabel, isValidThemeColor, typeLabel, type PresentationTemplate } from "./theme";

export function TemplateGallery({
  templates,
  selectedId,
  onSelect,
}: {
  templates: PresentationTemplate[];
  selectedId: string | null;
  onSelect: (template: PresentationTemplate | null) => void;
}) {
  const card =
    "relative flex h-full w-full flex-col rounded-lg border p-4 text-left transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-900";
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Presentation templates">
      <li>
        <button
          type="button"
          aria-pressed={selectedId === null}
          onClick={() => onSelect(null)}
          className={cn(card, selectedId === null && "border-blue-600 ring-1 ring-blue-600")}
        >
          <span className="mb-2 flex items-center gap-2 font-semibold">
            <LayoutTemplate className="h-4 w-4" aria-hidden />
            No template
          </span>
          <span className="text-sm text-muted-foreground">Let Beacon choose an outline for the audience and type.</span>
          {selectedId === null && <Check className="absolute right-3 top-3 h-4 w-4 text-blue-600" aria-hidden />}
        </button>
      </li>
      {templates.map((t) => {
        const selected = selectedId === t.id;
        return (
          <li key={t.id}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : t)}
              className={cn(card, selected && "border-blue-600 ring-1 ring-blue-600")}
            >
              <span className="mb-1 flex items-center gap-2 pr-6 font-semibold">
                {t.themeColor && isValidThemeColor(t.themeColor) && (
                  <span className="inline-block h-3 w-3 flex-shrink-0 rounded-full border" style={{ backgroundColor: t.themeColor }} aria-hidden />
                )}
                {t.name}
              </span>
              {t.description && <span className="mb-3 line-clamp-2 text-sm text-muted-foreground">{t.description}</span>}
              <span className="mt-auto flex flex-wrap gap-1">
                <Badge variant="outline">{audienceLabel(t.audience)}</Badge>
                <Badge variant="secondary">{typeLabel(t.type)}</Badge>
                <Badge variant="outline">{t.slideCount} slides</Badge>
                {!t.builtIn && <Badge variant="low">Custom</Badge>}
              </span>
              {t.outline.length > 0 && (
                <span className="mt-2 line-clamp-2 text-xs text-muted-foreground">{t.outline.slice(0, 5).join(" · ")}</span>
              )}
              {selected && <Check className="absolute right-3 top-3 h-4 w-4 text-blue-600" aria-hidden />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
