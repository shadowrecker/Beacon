"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ITEM_PRIORITIES, ITEM_STATUSES, PRIORITY_LABEL, STATUS_LABEL, type ItemPriority, type ItemStatus } from "./labels";

export type RoadmapItem = RouterOutputs["roadmap"]["get"]["items"][number];

interface ItemDialogProps {
  projectId: string;
  roadmapId: string;
  /** Item to edit; omit to add a new item. */
  item?: RoadmapItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ItemDialog({ projectId, roadmapId, item, open, onOpenChange }: ItemDialogProps) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ItemStatus>("PLANNED");
  const [priority, setPriority] = useState<ItemPriority>("P2");
  const [quarter, setQuarter] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? "");
    setDescription(item?.description ?? "");
    setStatus(item?.status ?? "PLANNED");
    setPriority(item?.priority ?? "P2");
    setQuarter(item?.quarter ?? "");
  }, [open, item]);

  const onSuccess = async () => {
    await utils.roadmap.get.invalidate({ projectId, roadmapId });
    await utils.roadmap.list.invalidate({ projectId });
    toast.success(item ? "Item updated" : "Item added");
    onOpenChange(false);
  };
  const add = trpc.roadmap.addItem.useMutation({ onSuccess });
  const update = trpc.roadmap.updateItem.useMutation({ onSuccess });
  const pending = add.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const fields = {
      title: title.trim(),
      description: description.trim() || null,
      status,
      priority,
      quarter: quarter.trim() || null,
    };
    if (item) update.mutate({ projectId, itemId: item.id, ...fields });
    else add.mutate({ projectId, roadmapId, ...fields });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{item ? "Edit roadmap item" : "Add roadmap item"}</DialogTitle>
            <DialogDescription>Roadmap items are compared against customer themes in gap analysis.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="roadmap-item-title">Title</Label>
            <Input
              id="roadmap-item-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="roadmap-item-description">Description</Label>
            <Textarea
              id="roadmap-item-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
              rows={4}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="roadmap-item-status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ItemStatus)}>
                <SelectTrigger id="roadmap-item-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-item-priority">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as ItemPriority)}>
                <SelectTrigger id="roadmap-item-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roadmap-item-quarter">Quarter</Label>
              <Input
                id="roadmap-item-quarter"
                value={quarter}
                onChange={(e) => setQuarter(e.target.value)}
                maxLength={50}
                placeholder="e.g. Q3 2026"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !title.trim()}>
              {pending ? "Saving…" : item ? "Save changes" : "Add item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
