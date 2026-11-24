"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { CompetitorFields, competitorFormErrors, EMPTY_COMPETITOR, type CompetitorFormValues } from "./competitor-form";

export function AddCompetitorDialog({ canScan }: { canScan: boolean }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<CompetitorFormValues>(EMPTY_COMPETITOR);
  const [touched, setTouched] = useState(false);
  const errors = touched ? competitorFormErrors(values) : {};

  const scan = trpc.competitive.runScan.useMutation();
  const add = trpc.competitive.addCompetitor.useMutation();
  const pending = add.isPending || scan.isPending;

  const submit = async (andScan: boolean) => {
    setTouched(true);
    if (Object.keys(competitorFormErrors(values)).length > 0) return;
    const created = await add.mutateAsync({
      name: values.name.trim(),
      website: values.website.trim(),
      captureUrl: values.captureUrl.trim(),
      g2Url: values.g2Url.trim(),
      description: values.description.trim() || undefined,
    });
    await utils.competitive.listCompetitors.invalidate();
    setOpen(false);
    setValues(EMPTY_COMPETITOR);
    setTouched(false);
    if (andScan && (created.website || created.captureUrl)) {
      try {
        await scan.mutateAsync({ id: created.id });
        toast.success(`${created.name} added. The first scan is running.`);
      } catch {
        toast.success(`${created.name} added.`);
      }
      router.push(`/competitive/${created.id}`);
      return;
    }
    toast.success(`${created.name} added.`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        setOpen(o);
        if (!o) setTouched(false);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" aria-hidden />
          Add competitor
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a competitor</DialogTitle>
          <DialogDescription>Beacon watches their public pages for product, pricing and company updates.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false).catch(() => undefined);
          }}
          noValidate
        >
          <CompetitorFields idPrefix="add-competitor" values={values} onChange={setValues} errors={errors} disabled={pending} />
          <DialogFooter className="mt-6 gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            {canScan && (
              <Button
                type="button"
                variant="secondary"
                disabled={pending || (!values.website.trim() && !values.captureUrl.trim())}
                onClick={() => void submit(true).catch(() => undefined)}
              >
                Add and scan
              </Button>
            )}
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
