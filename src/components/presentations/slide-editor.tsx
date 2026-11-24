"use client";

/**
 * Edits one slide (title, subtitle, bullets, speaker notes, layout) through
 * presentation.updateSlide. Limits mirror the server's slide schema. A
 * CONFLICT (someone else changed the deck) reloads the presentation.
 */
import { useState, type FormEvent } from "react";
import { TRPCClientError } from "@trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { LAYOUT_OPTIONS, type Slide, type SlideLayout } from "./theme";

const MAX_BULLETS = 8;
const MAX_TITLE = 200;
const MAX_SUBTITLE = 300;
const MAX_BULLET = 300;
const MAX_NOTES = 3_000;

export function SlideEditor({
  presentationId,
  slide,
  onDone,
}: {
  presentationId: string;
  slide: Slide;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(slide.title);
  const [subtitle, setSubtitle] = useState(slide.subtitle);
  const [bullets, setBullets] = useState(slide.bulletPoints.join("\n"));
  const [notes, setNotes] = useState(slide.speakerNotes);
  const [layout, setLayout] = useState<SlideLayout>(slide.layout);

  const bulletList = bullets
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const errors = {
    title: !title.trim() ? "A slide title is required" : title.trim().length > MAX_TITLE ? `At most ${MAX_TITLE} characters` : null,
    subtitle: subtitle.trim().length > MAX_SUBTITLE ? `At most ${MAX_SUBTITLE} characters` : null,
    bullets:
      bulletList.length > MAX_BULLETS
        ? `At most ${MAX_BULLETS} bullet points (${bulletList.length} entered)`
        : bulletList.some((b) => b.length > MAX_BULLET)
          ? `Each bullet point can be at most ${MAX_BULLET} characters`
          : null,
    notes: notes.trim().length > MAX_NOTES ? `At most ${MAX_NOTES} characters` : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const update = trpc.presentation.updateSlide.useMutation({
    meta: { silent: true },
    onSuccess: async () => {
      toast.success(`Slide ${slide.slideNumber} saved`);
      await utils.presentation.get.invalidate({ id: presentationId });
      onDone();
    },
    onError: async (err) => {
      const code = err instanceof TRPCClientError ? (err.data as { code?: string } | undefined)?.code : undefined;
      if (code === "CONFLICT") {
        toast.error("This presentation changed while you were editing. The latest version has been loaded.");
        await utils.presentation.get.invalidate({ id: presentationId });
        onDone();
        return;
      }
      toast.error(err.message || "Couldn't save the slide");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    update.mutate({
      id: presentationId,
      slideNumber: slide.slideNumber,
      title: title.trim(),
      subtitle: subtitle.trim(),
      bulletPoints: bulletList,
      speakerNotes: notes.trim(),
      layout,
    });
  };

  const field = "space-y-2";
  const errorText = (id: string, msg: string | null) =>
    msg ? (
      <p id={id} className="text-sm text-destructive" role="alert">
        {msg}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-5" aria-label={`Edit slide ${slide.slideNumber}`}>
      <div className={field}>
        <Label htmlFor="slide-title">Title</Label>
        <Input
          id="slide-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={MAX_TITLE + 50}
          aria-invalid={Boolean(errors.title)}
          aria-describedby={errors.title ? "slide-title-error" : undefined}
          required
        />
        {errorText("slide-title-error", errors.title)}
      </div>

      <div className={field}>
        <Label htmlFor="slide-subtitle">Subtitle (optional)</Label>
        <Input
          id="slide-subtitle"
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          aria-invalid={Boolean(errors.subtitle)}
          aria-describedby={errors.subtitle ? "slide-subtitle-error" : undefined}
        />
        {errorText("slide-subtitle-error", errors.subtitle)}
      </div>

      <div className={field}>
        <Label htmlFor="slide-layout">Layout</Label>
        <Select value={layout} onValueChange={(v) => setLayout(v as SlideLayout)}>
          <SelectTrigger id="slide-layout" aria-label="Slide layout">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LAYOUT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className={field}>
        <Label htmlFor="slide-bullets">Bullet points (one per line, up to {MAX_BULLETS})</Label>
        <Textarea
          id="slide-bullets"
          value={bullets}
          onChange={(e) => setBullets(e.target.value)}
          className="min-h-40"
          aria-invalid={Boolean(errors.bullets)}
          aria-describedby={errors.bullets ? "slide-bullets-error" : "slide-bullets-help"}
        />
        {errors.bullets ? (
          errorText("slide-bullets-error", errors.bullets)
        ) : (
          <p id="slide-bullets-help" className="text-xs text-muted-foreground">
            {bulletList.length} of {MAX_BULLETS} bullet points
          </p>
        )}
      </div>

      <div className={field}>
        <Label htmlFor="slide-notes">Speaker notes</Label>
        <Textarea
          id="slide-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="min-h-32"
          aria-invalid={Boolean(errors.notes)}
          aria-describedby={errors.notes ? "slide-notes-error" : undefined}
        />
        {errorText("slide-notes-error", errors.notes)}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={invalid || update.isPending}>
          {update.isPending ? "Saving…" : "Save slide"}
        </Button>
      </div>
    </form>
  );
}
