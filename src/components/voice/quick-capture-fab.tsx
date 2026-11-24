"use client";

import { useState, type FormEvent } from "react";
import { Loader2, PenLine } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { NativeSelect } from "./native-select";

export const CAPTURE_TYPES = [
  { value: "QUICK_THOUGHT", label: "Quick thought" },
  { value: "CALL_HIGHLIGHT", label: "Call highlight" },
  { value: "VOICE_NOTE", label: "Voice note (typed)" },
] as const;
export type CaptureType = (typeof CAPTURE_TYPES)[number]["value"];

/** Floating "capture a thought" button. With a project, the note becomes a document there. */
export function QuickCaptureFab({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [type, setType] = useState<CaptureType>("QUICK_THOUGHT");
  const capture = trpc.voice.quickCapture.useMutation({
    onSuccess: async (res) => {
      toast.success(res.documentId ? `Saved to ${projectName ?? "the project"}` : "Saved to your captures");
      setContent("");
      setOpen(false);
      await utils.voice.listQuickCaptures.invalidate();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    capture.mutate({ projectId, type, content: content.trim() });
  };

  return (
    <>
      <Button
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full shadow-lg"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Quick capture"
      >
        <PenLine className="h-6 w-6" aria-hidden />
      </Button>
      <Dialog open={open} onOpenChange={(o) => !capture.isPending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quick capture</DialogTitle>
            <DialogDescription>
              {projectId ? `Saved as a note in ${projectName ?? "the selected project"}.` : "Saved to your captures; file it into a project later."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="fab-capture-type">Type</Label>
              <NativeSelect id="fab-capture-type" value={type} onChange={(e) => setType(e.target.value as CaptureType)}>
                {CAPTURE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fab-capture-content">Note</Label>
              <Textarea
                id="fab-capture-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
                maxLength={20_000}
                placeholder="What did you just hear?"
                disabled={capture.isPending}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={capture.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={capture.isPending || !content.trim()}>
                {capture.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
