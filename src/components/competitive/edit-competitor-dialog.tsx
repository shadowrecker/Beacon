"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { CompetitorFields, competitorFormErrors, type CompetitorFormValues } from "./competitor-form";

type Competitor = RouterOutputs["competitive"]["getCompetitor"];

function valuesOf(c: Competitor): CompetitorFormValues {
  return {
    name: c.name,
    website: c.website ?? "",
    captureUrl: c.captureUrl ?? "",
    g2Url: c.g2Url ?? "",
    description: c.description ?? "",
  };
}

export function EditCompetitorDialog({ competitor }: { competitor: Competitor }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CompetitorFormValues>(() => valuesOf(competitor));
  const [touched, setTouched] = useState(false);
  const errors = touched ? competitorFormErrors(values) : {};

  const update = trpc.competitive.updateCompetitor.useMutation({
    onSuccess: async () => {
      await utils.competitive.invalidate();
      toast.success("Competitor updated.");
      setOpen(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (update.isPending) return;
        if (o) {
          setValues(valuesOf(competitor));
          setTouched(false);
        }
        setOpen(o);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-2 h-4 w-4" aria-hidden />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {competitor.name}</DialogTitle>
          <DialogDescription>Leave a URL empty to stop monitoring it.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (Object.keys(competitorFormErrors(values)).length > 0) return;
            // Every field is sent explicitly so nothing is cleared by omission.
            update.mutate({
              id: competitor.id,
              name: values.name.trim(),
              website: values.website.trim(),
              captureUrl: values.captureUrl.trim(),
              g2Url: values.g2Url.trim(),
              description: values.description.trim(),
            });
          }}
        >
          <CompetitorFields idPrefix="edit-competitor" values={values} onChange={setValues} errors={errors} disabled={update.isPending} />
          <DialogFooter className="mt-6 gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
