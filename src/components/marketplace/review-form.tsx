"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { StarPicker } from "./rating-stars";

type MyReview = RouterOutputs["marketplace"]["get"]["myReview"];

/** Write or edit the caller's single review of a connector. */
export function ReviewForm({ slug, myReview }: { slug: string; myReview: MyReview }) {
  const utils = trpc.useUtils();
  const [rating, setRating] = useState(myReview?.rating ?? 0);
  const [title, setTitle] = useState(myReview?.title ?? "");
  const [content, setContent] = useState(myReview?.content ?? "");

  const refresh = () => Promise.all([utils.marketplace.get.invalidate({ slug }), utils.marketplace.getReviews.invalidate({ slug }), utils.marketplace.browse.invalidate()]);
  const save = trpc.marketplace.addReview.useMutation({
    onSuccess: async () => {
      toast.success(myReview ? "Review updated" : "Thanks for your review");
      await refresh();
    },
  });
  const remove = trpc.marketplace.deleteReview.useMutation({
    onSuccess: async () => {
      setRating(0);
      setTitle("");
      setContent("");
      toast.success("Review deleted");
      await refresh();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (rating < 1) return;
    save.mutate({ slug, rating, title: title.trim() || undefined, content: content.trim() || undefined });
  };
  const busy = save.isPending || remove.isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border p-4">
      <h3 className="font-semibold">{myReview ? "Your review" : "Write a review"}</h3>
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Rating</span>
        <StarPicker name={`rating-${slug}`} value={rating} onChange={setRating} disabled={busy} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`review-title-${slug}`}>Title (optional)</Label>
        <Input id={`review-title-${slug}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={busy} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`review-content-${slug}`}>Review (optional)</Label>
        <Textarea id={`review-content-${slug}`} value={content} onChange={(e) => setContent(e.target.value)} maxLength={5000} rows={4} disabled={busy} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {myReview && (
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => remove.mutate({ slug })} disabled={busy}>
            Delete review
          </Button>
        )}
        <Button type="submit" disabled={busy || rating < 1}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {myReview ? "Update review" : "Post review"}
        </Button>
      </div>
      {rating < 1 && <p className="text-xs text-muted-foreground">Choose a star rating to post.</p>}
    </form>
  );
}
