"use client";

import { useId, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { KeyRound, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { API_SCOPES, DEFAULT_RATE_LIMIT, MAX_RATE_LIMIT, SCOPE_DESCRIPTIONS, type ApiScope } from "@/server/api/scopes";
import { SecretReveal } from "./secret-reveal";

const EXPIRY_OPTIONS = [
  { value: "", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

const selectClass =
  "flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950";

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (key: string) => void }) {
  const uid = useId();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(["projects:read"]));
  const [rateLimit, setRateLimit] = useState(String(DEFAULT_RATE_LIMIT));
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = trpc.apiKey.create.useMutation({
    meta: { silent: true },
    onSuccess: async (res) => {
      await utils.apiKey.list.invalidate();
      onOpenChange(false);
      setName("");
      setScopes(new Set(["projects:read"]));
      setRateLimit(String(DEFAULT_RATE_LIMIT));
      setExpiry("");
      onCreated(res.key);
    },
    onError: (err) => setError(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const limit = Number(rateLimit);
    if (!name.trim()) return setError("Name is required");
    if (scopes.size === 0) return setError("Choose at least one scope");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RATE_LIMIT) return setError(`Rate limit must be between 1 and ${MAX_RATE_LIMIT} requests per minute`);
    create.mutate({ name: name.trim(), scopes: [...scopes], rateLimit: limit, expiresInDays: expiry ? Number(expiry) : undefined });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>Keys belong to this workspace and can only reach its data. Grant only the scopes you need.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>Name</Label>
            <Input id={`${uid}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="CI pipeline" />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Scopes</legend>
            {API_SCOPES.map((s) => (
              <div key={s} className="flex items-start gap-3">
                <Switch
                  id={`${uid}-${s}`}
                  checked={scopes.has(s)}
                  onCheckedChange={(on) =>
                    setScopes((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(s);
                      else next.delete(s);
                      return next;
                    })
                  }
                />
                <Label htmlFor={`${uid}-${s}`} className="space-y-0.5">
                  <span className="block font-mono text-xs">{s}</span>
                  <span className="block font-normal text-gray-500">{SCOPE_DESCRIPTIONS[s]}</span>
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-rate`}>Rate limit (requests/min)</Label>
              <Input id={`${uid}-rate`} type="number" min={1} max={MAX_RATE_LIMIT} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-expiry`}>Expires</Label>
              <select id={`${uid}-expiry`} className={selectClass} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeyList() {
  const utils = trpc.useUtils();
  const [showRevoked, setShowRevoked] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const keys = trpc.apiKey.list.useInfiniteQuery({ includeRevoked: showRevoked, limit: 50 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const revoke = trpc.apiKey.revoke.useMutation({
    onSuccess: async () => {
      toast.success("API key revoked");
      setRevoking(null);
      await utils.apiKey.list.invalidate();
    },
  });

  const pages = keys.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const canManage = pages[0]?.canManage ?? false;

  return (
    <section aria-labelledby="api-keys-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="api-keys-heading" className="text-xl font-semibold">
          API keys
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="show-revoked" checked={showRevoked} onCheckedChange={setShowRevoked} />
            <Label htmlFor="show-revoked">Show revoked</Label>
          </div>
          {canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden /> Create key
            </Button>
          )}
        </div>
      </div>
      {!canManage && !keys.isLoading && !keys.isError && (
        <p className="text-sm text-gray-600 dark:text-gray-400">Only workspace owners and admins can create or revoke API keys.</p>
      )}

      {keys.isLoading ? (
        <LoadingState rows={3} label="Loading API keys" />
      ) : keys.isError ? (
        <ErrorState message={keys.error.message} onRetry={() => void keys.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<KeyRound className="h-8 w-8" />} title="No API keys" description="Create a key to call the Beacon REST API or use the SDK." />
      ) : (
        <ul className="divide-y rounded-lg border dark:divide-gray-800 dark:border-gray-800">
          {items.map((k) => {
            const expired = k.expiresAt ? new Date(k.expiresAt).getTime() < Date.now() : false;
            return (
              <li key={k.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-start ${k.revokedAt ? "opacity-60" : ""}`}>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{k.name}</span>
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-900">{k.prefix}…</code>
                    {k.revokedAt && <Badge variant="destructive">Revoked</Badge>}
                    {!k.revokedAt && expired && <Badge variant="medium">Expired</Badge>}
                  </div>
                  <ul className="flex flex-wrap gap-1" aria-label="Scopes">
                    {k.scopes.map((s) => (
                      <li key={s}>
                        <Badge variant="outline" className="font-mono text-[11px]">
                          {s}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-gray-500">
                    {k.rateLimit} req/min · created by {k.createdBy} {formatDistanceToNow(new Date(k.createdAt), { addSuffix: true })} · last used{" "}
                    {k.lastUsedAt ? formatDistanceToNow(new Date(k.lastUsedAt), { addSuffix: true }) : "never"}
                    {k.expiresAt && ` · ${expired ? "expired" : "expires"} ${formatDistanceToNow(new Date(k.expiresAt), { addSuffix: true })}`}
                  </p>
                </div>
                {canManage && !k.revokedAt && (
                  <Button variant="outline" size="sm" onClick={() => setRevoking({ id: k.id, name: k.name })}>
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {keys.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void keys.fetchNextPage()} disabled={keys.isFetchingNextPage}>
          {keys.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={setRevealed} />
      <SecretReveal
        title="Your new API key"
        description="Send it as a bearer token: Authorization: Bearer <key>."
        secret={revealed}
        onClose={() => setRevealed(null)}
      />
      <Dialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke “{revoking?.name}”?</DialogTitle>
            <DialogDescription>Requests using this key will fail immediately. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoking && revoke.mutate({ id: revoking.id })}>
              {revoke.isPending ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
