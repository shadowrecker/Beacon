"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc/client";
import { DOCUMENT_TYPES, type DocumentTypeValue } from "./document-types";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function UrlImportDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const urlId = useId();
  const titleId = useId();
  const typeId = useId();
  const utils = trpc.useUtils();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<DocumentTypeValue>("OTHER");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setTitle("");
      setType("OTHER");
      setError(null);
    }
  }, [open]);

  const importUrl = trpc.document.importUrl.useMutation({
    meta: { silent: true },
    onSuccess: async () => {
      await Promise.all([utils.document.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
      toast.success("Page imported. Processing has started.");
      onOpenChange(false);
    },
    onError: (err) => setError(err.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!isHttpUrl(trimmed)) {
      setError("Enter a full web address starting with https://");
      return;
    }
    setError(null);
    importUrl.mutate({ projectId, url: trimmed, title: title.trim() || undefined, type });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !importUrl.isPending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Import from a URL</DialogTitle>
            <DialogDescription>Beacon fetches the page, keeps its readable text (no scripts or navigation) and adds it as a document.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={urlId}>Page URL</Label>
            <Input id={urlId} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} placeholder="https://" required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor={titleId}>Title (optional)</Label>
            <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Defaults to the page title" />
          </div>
          <div className="space-y-2">
            <Label htmlFor={typeId}>Document type</Label>
            <select
              id={typeId}
              value={type}
              onChange={(e) => setType(e.target.value as DocumentTypeValue)}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importUrl.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={importUrl.isPending}>
              {importUrl.isPending ? "Importing…" : "Import page"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
