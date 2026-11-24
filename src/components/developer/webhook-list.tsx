"use client";

import { useId, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronRight, Plus, Webhook as WebhookIcon } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { WEBHOOK_EVENTS, type EventType } from "@/server/events/catalog";
import { TRIGGER_EVENTS } from "@/server/workflows/definitions";
import { SecretReveal } from "./secret-reveal";
import { DeliveryStatusBadge, WebhookDeliveries } from "./webhook-deliveries";

function eventLabel(e: string): string {
  return e in TRIGGER_EVENTS ? TRIGGER_EVENTS[e as keyof typeof TRIGGER_EVENTS].label : e;
}

interface Editing {
  id: string | null;
  name: string;
  url: string;
  events: EventType[];
  active: boolean;
}

/** Mounted per edit session (keyed by webhook), so the draft starts from `editing`. */
function WebhookDialog({ editing, onClose, onCreated }: { editing: Editing; onClose: () => void; onCreated: (secret: string) => void }) {
  const uid = useId();
  const utils = trpc.useUtils();
  const [d, setDraft] = useState<Editing>(editing);
  const [error, setError] = useState<string | null>(null);

  const done = async () => {
    await utils.webhook.list.invalidate();
    onClose();
  };
  const create = trpc.webhook.create.useMutation({
    meta: { silent: true },
    onSuccess: async (res) => {
      await done();
      onCreated(res.secret);
    },
    onError: (err) => setError(err.message),
  });
  const update = trpc.webhook.update.useMutation({
    meta: { silent: true },
    onSuccess: async () => {
      toast.success("Webhook saved");
      await done();
    },
    onError: (err) => setError(err.message),
  });

  const set = (patch: Partial<Editing>) => setDraft({ ...d, ...patch });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!d.name.trim()) return setError("Name is required");
    if (!/^https:\/\//i.test(d.url.trim())) return setError("Webhook URLs must start with https://");
    if (d.events.length === 0) return setError("Choose at least one event");
    if (d.id) update.mutate({ id: d.id, name: d.name.trim(), url: d.url.trim(), events: d.events, active: d.active });
    else create.mutate({ name: d.name.trim(), url: d.url.trim(), events: d.events });
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{d.id ? "Edit webhook" : "Add a webhook"}</DialogTitle>
            <DialogDescription>Beacon POSTs signed JSON to this URL when the selected events happen in this workspace.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>Name</Label>
            <Input id={`${uid}-name`} value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-url`}>Endpoint URL</Label>
            <Input id={`${uid}-url`} type="url" value={d.url} onChange={(e) => set({ url: e.target.value })} maxLength={2000} placeholder="https://example.com/beacon-webhook" aria-describedby={`${uid}-url-help`} />
            <p id={`${uid}-url-help`} className="text-xs text-gray-500">
              Must be a public https:// URL. Redirects are not followed.
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <label key={ev} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={d.events.includes(ev)}
                    onChange={(e) => set({ events: e.target.checked ? [...d.events, ev] : d.events.filter((x) => x !== ev) })}
                  />
                  <span>
                    {eventLabel(ev)}
                    <span className="block font-mono text-xs text-gray-500">{ev}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {d.id && (
            <div className="flex items-center gap-2">
              <Switch id={`${uid}-active`} checked={d.active} onCheckedChange={(active) => set({ active })} />
              <Label htmlFor={`${uid}-active`}>Active</Label>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : d.id ? "Save" : "Add webhook"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WebhookList() {
  const utils = trpc.useUtils();
  const hooks = trpc.webhook.list.useInfiniteQuery({ limit: 50 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "rotate"; id: string; name: string } | null>(null);

  const test = trpc.webhook.test.useMutation({
    onSuccess: async (_res, vars) => {
      toast.success("Test delivery queued");
      setExpanded(vars.id);
      await utils.webhook.getDeliveries.invalidate({ webhookId: vars.id });
    },
  });
  const rotate = trpc.webhook.rotateSecret.useMutation({
    onSuccess: (res) => {
      setConfirm(null);
      setSecret(res.secret);
    },
  });
  const remove = trpc.webhook.delete.useMutation({
    onSuccess: async () => {
      toast.success("Webhook deleted");
      setConfirm(null);
      await utils.webhook.list.invalidate();
    },
  });

  const pages = hooks.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const canManage = pages[0]?.canManage ?? false;

  return (
    <section aria-labelledby="webhooks-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="webhooks-heading" className="text-xl font-semibold">
          Webhooks
        </h2>
        {canManage && (
          <Button onClick={() => setEditing({ id: null, name: "", url: "", events: ["synthesis.completed"], active: true })}>
            <Plus className="mr-2 h-4 w-4" aria-hidden /> Add webhook
          </Button>
        )}
      </div>
      {!canManage && !hooks.isLoading && !hooks.isError && (
        <p className="text-sm text-gray-600 dark:text-gray-400">Only workspace owners and admins can manage webhooks.</p>
      )}

      {hooks.isLoading ? (
        <LoadingState rows={3} label="Loading webhooks" />
      ) : hooks.isError ? (
        <ErrorState message={hooks.error.message} onRetry={() => void hooks.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<WebhookIcon className="h-8 w-8" />} title="No webhooks" description="Add a webhook to receive events like completed syntheses and new recommendations." />
      ) : (
        <ul className="space-y-3">
          {items.map((h) => {
            const open = expanded === h.id;
            return (
              <li key={h.id} className="rounded-lg border dark:border-gray-800">
                <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{h.name}</span>
                      {h.active ? (
                        <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">Active</Badge>
                      ) : h.disabledAt ? (
                        <Badge variant="destructive">Disabled after repeated failures</Badge>
                      ) : (
                        <Badge variant="secondary">Paused</Badge>
                      )}
                      {h.lastDelivery && <DeliveryStatusBadge status={h.lastDelivery.status} />}
                    </div>
                    <p className="break-all font-mono text-xs text-gray-600 dark:text-gray-400">{h.url}</p>
                    <p className="text-xs text-gray-500">
                      {h.events.map(eventLabel).join(", ")}
                      {h.lastTriggeredAt && ` · last delivered ${formatDistanceToNow(new Date(h.lastTriggeredAt), { addSuffix: true })}`}
                      {h.consecutiveFailures > 0 && ` · ${h.consecutiveFailures} consecutive failed deliveries`}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: h.id })}>
                        Send test
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing({ id: h.id, name: h.name, url: h.url, events: h.events as EventType[], active: h.active })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: "rotate", id: h.id, name: h.name })}>
                        Rotate secret
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: "delete", id: h.id, name: h.name })}>
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
                <div className="border-t px-4 py-2 dark:border-gray-800">
                  <button
                    type="button"
                    className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:underline dark:text-gray-300"
                    aria-expanded={open}
                    aria-controls={`deliveries-${h.id}`}
                    onClick={() => setExpanded(open ? null : h.id)}
                  >
                    {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                    Delivery log
                  </button>
                  {open && (
                    <div id={`deliveries-${h.id}`} className="py-3">
                      <WebhookDeliveries webhookId={h.id} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hooks.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void hooks.fetchNextPage()} disabled={hooks.isFetchingNextPage}>
          {hooks.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      {editing && <WebhookDialog key={editing.id ?? "new"} editing={editing} onClose={() => setEditing(null)} onCreated={setSecret} />}
      <SecretReveal
        title="Webhook signing secret"
        description="Use it to verify the x-beacon-signature header on every delivery."
        secret={secret}
        onClose={() => setSecret(null)}
      />
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.kind === "delete" ? `Delete “${confirm?.name}”?` : `Rotate the secret for “${confirm?.name}”?`}</DialogTitle>
            <DialogDescription>
              {confirm?.kind === "delete"
                ? "Deliveries stop immediately and the delivery log is deleted."
                : "The current secret stops working right away. Update your receiver with the new secret."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending || rotate.isPending}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "delete") remove.mutate({ id: confirm.id });
                else rotate.mutate({ id: confirm.id });
              }}
            >
              {confirm?.kind === "delete" ? "Delete webhook" : "Rotate secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
