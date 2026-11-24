"use client";

import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { NativeSelect } from "@/components/voice/native-select";
import { urlError } from "./competitor-form";
import { SENTIMENT_LABEL, SENTIMENTS, UPDATE_TYPE_LABEL, UPDATE_TYPES, type SentimentValue, type UpdateType } from "./labels";

/**
 * Record an update by hand. Review sites aren't scraped, so review
 * insights from G2 or elsewhere are entered here.
 */
export function ManualUpdateForm({ competitorId }: { competitorId: string }) {
  const utils = trpc.useUtils();
  const [type, setType] = useState<UpdateType>("REVIEW");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sentiment, setSentiment] = useState<SentimentValue>("NEUTRAL");
  const [touched, setTouched] = useState(false);
  const sourceError = touched ? urlError(sourceUrl) : null;

  const add = trpc.competitive.addManualUpdate.useMutation({
    onSuccess: async () => {
      setTitle("");
      setContent("");
      setSourceUrl("");
      setTouched(false);
      toast.success("Update recorded.");
      await Promise.all([utils.competitive.getUpdates.invalidate({ competitorId }), utils.competitive.getCompetitor.invalidate({ id: competitorId }), utils.competitive.listCompetitors.invalidate()]);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!title.trim() || !content.trim() || urlError(sourceUrl)) return;
    add.mutate({ competitorId, type, title: title.trim(), content: content.trim(), sourceUrl: sourceUrl.trim(), sentiment });
  };

  const p = `manual-${competitorId}`;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <p className="text-sm text-muted-foreground">Review sites aren&apos;t scraped. Paste review insights, sales notes or announcements here.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${p}-type`}>Type</Label>
          <NativeSelect id={`${p}-type`} value={type} onChange={(e) => setType(e.target.value as UpdateType)} disabled={add.isPending}>
            {UPDATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {UPDATE_TYPE_LABEL[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${p}-sentiment`}>Sentiment</Label>
          <NativeSelect id={`${p}-sentiment`} value={sentiment} onChange={(e) => setSentiment(e.target.value as SentimentValue)} disabled={add.isPending}>
            {SENTIMENTS.map((s) => (
              <option key={s} value={s}>
                {SENTIMENT_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${p}-title`}>Title *</Label>
        <Input
          id={`${p}-title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          aria-invalid={touched && !title.trim()}
          disabled={add.isPending}
          placeholder="Customers praise the new onboarding flow"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${p}-content`}>Details *</Label>
        <Textarea
          id={`${p}-content`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={10_000}
          rows={4}
          required
          aria-invalid={touched && !content.trim()}
          disabled={add.isPending}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${p}-source`}>Source link</Label>
        <Input
          id={`${p}-source`}
          type="url"
          inputMode="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          maxLength={2000}
          aria-invalid={!!sourceError}
          aria-describedby={sourceError ? `${p}-source-error` : undefined}
          disabled={add.isPending}
          placeholder="https://www.g2.com/products/acme/reviews"
        />
        {sourceError && (
          <p id={`${p}-source-error`} className="text-xs text-destructive">
            {sourceError}
          </p>
        )}
      </div>
      {touched && (!title.trim() || !content.trim()) && <p className="text-xs text-destructive">Add a title and details.</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? "Saving…" : "Add update"}
        </Button>
      </div>
    </form>
  );
}
