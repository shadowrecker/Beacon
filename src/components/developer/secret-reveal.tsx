"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/**
 * One-time reveal of a newly created secret (API key or webhook signing secret).
 * The value only lives in component state: closing the dialog discards it.
 */
export function SecretReveal({
  title,
  description,
  secret,
  onClose,
}: {
  title: string;
  description: string;
  secret: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  }

  return (
    <Dialog
      open={!!secret}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p className="rounded-md border border-yellow-300 bg-yellow-50 p-2 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
            This is the only time it will be shown. Store it somewhere safe, such as your secrets manager.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md bg-gray-100 px-3 py-2 font-mono text-sm dark:bg-gray-900" aria-label="Secret value">
              {secret}
            </code>
            <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy to clipboard">
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I&apos;ve stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
