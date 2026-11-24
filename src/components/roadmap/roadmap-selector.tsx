"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { SOURCE_LABEL } from "./labels";

export type RoadmapSummary = RouterOutputs["roadmap"]["list"]["items"][number];

function NameDialog({
  open,
  onOpenChange,
  title,
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Give the roadmap a name your team will recognize.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="roadmap-name">Name</Label>
            <Input id="roadmap-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface RoadmapSelectorProps {
  projectId: string;
  roadmaps: RoadmapSummary[];
  selectedId: string | null;
  onSelect: (roadmapId: string | null) => void;
}

export function RoadmapSelector({ projectId, roadmaps, selectedId, onSelect }: RoadmapSelectorProps) {
  const utils = trpc.useUtils();
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | null>(null);
  const selected = roadmaps.find((r) => r.id === selectedId) ?? null;

  const create = trpc.roadmap.create.useMutation({
    onSuccess: async (r) => {
      await utils.roadmap.list.invalidate({ projectId });
      onSelect(r.id);
      setDialog(null);
      toast.success("Roadmap created");
    },
  });
  const rename = trpc.roadmap.rename.useMutation({
    onSuccess: async () => {
      await utils.roadmap.list.invalidate({ projectId });
      await utils.roadmap.get.invalidate({ projectId });
      setDialog(null);
      toast.success("Roadmap renamed");
    },
  });
  const remove = trpc.roadmap.delete.useMutation({
    onSuccess: async () => {
      const next = roadmaps.find((r) => r.id !== selectedId);
      await utils.roadmap.list.invalidate({ projectId });
      onSelect(next?.id ?? null);
      setDialog(null);
      toast.success("Roadmap deleted");
    },
  });

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="w-full space-y-2 sm:max-w-sm">
        <Label htmlFor="roadmap-select">Roadmap</Label>
        <Select value={selectedId ?? undefined} onValueChange={onSelect} disabled={roadmaps.length === 0}>
          <SelectTrigger id="roadmap-select">
            <SelectValue placeholder={roadmaps.length === 0 ? "No roadmaps yet" : "Choose a roadmap"} />
          </SelectTrigger>
          <SelectContent>
            {roadmaps.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name} · {r.itemCount} item{r.itemCount === 1 ? "" : "s"} · {SOURCE_LABEL[r.source] ?? r.source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setDialog("create")}>
          <Plus className="mr-2 h-4 w-4" aria-hidden />
          New roadmap
        </Button>
        <Button variant="ghost" size="icon" aria-label="Rename roadmap" disabled={!selected} onClick={() => setDialog("rename")}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Delete roadmap" disabled={!selected} onClick={() => setDialog("delete")}>
          <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
        </Button>
      </div>

      <NameDialog
        open={dialog === "create"}
        onOpenChange={(o) => setDialog(o ? "create" : null)}
        title="New roadmap"
        initial=""
        submitLabel="Create roadmap"
        pending={create.isPending}
        onSubmit={(name) => create.mutate({ projectId, name })}
      />
      <NameDialog
        open={dialog === "rename"}
        onOpenChange={(o) => setDialog(o ? "rename" : null)}
        title="Rename roadmap"
        initial={selected?.name ?? ""}
        submitLabel="Save"
        pending={rename.isPending}
        onSubmit={(name) => selected && rename.mutate({ projectId, roadmapId: selected.id, name })}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
        title="Delete this roadmap?"
        description={
          selected
            ? `"${selected.name}" and its ${selected.itemCount} item${selected.itemCount === 1 ? "" : "s"} and gap analyses will be permanently deleted.`
            : undefined
        }
        confirmLabel="Delete roadmap"
        destructive
        pending={remove.isPending}
        onConfirm={() => selected && remove.mutate({ projectId, roadmapId: selected.id })}
      />
    </div>
  );
}
