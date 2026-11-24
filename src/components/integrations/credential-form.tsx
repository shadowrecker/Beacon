"use client";

import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { trpc, type RouterInputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { FieldSpec, ProviderInfo } from "./types";
import { NUMERIC_CONFIG_KEYS } from "./types";

export type FieldValues = Record<string, string>;

/** Renders provider field specs (credentials, OAuth start settings, sync settings). */
export function FieldInputs({
  fields,
  values,
  onChange,
  idPrefix,
  disabled,
}: {
  fields: FieldSpec[];
  values: FieldValues;
  onChange: (key: string, value: string) => void;
  idPrefix: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const helpId = f.help ? `${id}-help` : undefined;
        return (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={id}>
              {f.label}
              {f.required && (
                <span className="text-destructive" aria-hidden>
                  {" "}
                  *
                </span>
              )}
            </Label>
            {f.type === "select" ? (
              <Select value={values[f.key] || undefined} onValueChange={(v) => onChange(f.key, v)} disabled={disabled}>
                <SelectTrigger id={id} aria-describedby={helpId}>
                  <SelectValue placeholder="Choose…" />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.type === "list" ? (
              <Textarea
                id={id}
                value={values[f.key] ?? ""}
                onChange={(e) => onChange(f.key, e.target.value)}
                placeholder={f.placeholder ? `${f.placeholder}, …` : undefined}
                rows={2}
                maxLength={2000}
                disabled={disabled}
                aria-describedby={helpId}
              />
            ) : (
              <Input
                id={id}
                type={f.type === "password" ? "password" : f.type === "email" ? "email" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => onChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                required={f.required}
                aria-required={f.required}
                autoComplete={f.type === "password" ? "new-password" : "off"}
                spellCheck={false}
                maxLength={2000}
                disabled={disabled}
                aria-describedby={helpId}
              />
            )}
            {f.help && (
              <p id={helpId} className="text-xs text-muted-foreground">
                {f.help}
                {f.type === "list" ? " Separate values with commas or new lines." : ""}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function missingRequired(fields: FieldSpec[], values: FieldValues): boolean {
  return fields.some((f) => f.required && !(values[f.key] ?? "").trim());
}

/** Convert form strings to the shapes the server validates (lists → string[], numeric settings → number). */
export function toConfigPayload(fields: FieldSpec[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (f.type === "list") {
      out[f.key] = raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (!raw) {
      // An emptied text setting is cleared on the server; unset selects keep their value.
      if (f.type !== "select") out[f.key] = "";
      continue;
    }
    out[f.key] = NUMERIC_CONFIG_KEYS.has(f.key) ? Number(raw) : raw;
  }
  return out;
}

/** Stored config → form strings. */
export function configToValues(fields: FieldSpec[], config: Record<string, unknown>): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    const v = config[f.key];
    if (Array.isArray(v)) out[f.key] = v.filter((x) => typeof x === "string").join(", ");
    else if (typeof v === "string" || typeof v === "number") out[f.key] = String(v);
  }
  return out;
}

function trimmed(fields: FieldSpec[], values: FieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim();
    if (v) out[f.key] = v;
  }
  return out;
}

/** Same-origin URL that starts the OAuth flow (the server signs state and redirects). */
export function buildOAuthStartUrl(provider: ProviderInfo, projectId: string, values: FieldValues): string {
  const params = new URLSearchParams({ provider: provider.provider, projectId, ...trimmed(provider.startFields, values) });
  return `/api/integrations/oauth/start?${params.toString()}`;
}

/** API-token connect form: live-verified by the server before anything is saved. */
export function ApiKeyConnectForm({
  provider,
  projectId,
  onConnected,
  idPrefix = "connect",
}: {
  provider: ProviderInfo;
  projectId: string | undefined;
  onConnected?: () => void;
  idPrefix?: string;
}) {
  const utils = trpc.useUtils();
  const [values, setValues] = useState<FieldValues>({});
  const connect = trpc.integration.connect.useMutation({
    onSuccess: async (res) => {
      setValues({});
      toast.success(`${provider.name} connected${res.accountLabel ? ` (${res.accountLabel})` : ""}. The first sync has started.`);
      await Promise.all([utils.integration.list.invalidate(), utils.marketplace.get.invalidate(), utils.marketplace.listInstalled.invalidate()]);
      onConnected?.();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || missingRequired(provider.credentialFields, values)) return;
    connect.mutate({
      provider: provider.provider,
      projectId,
      credentials: trimmed(provider.credentialFields, values),
    } as RouterInputs["integration"]["connect"]);
  };

  const disabled = !projectId || missingRequired(provider.credentialFields, values) || connect.isPending;
  return (
    <form onSubmit={onSubmit} className="space-y-4" autoComplete="off">
      <FieldInputs
        fields={provider.credentialFields}
        values={values}
        onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
        idPrefix={`${idPrefix}-${provider.provider.toLowerCase()}`}
        disabled={connect.isPending}
      />
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        Credentials are checked with {provider.name}, encrypted at rest and never shown again.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={provider.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          Where do I find these?
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <Button type="submit" disabled={disabled}>
          {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          {connect.isPending ? "Verifying…" : `Connect ${provider.name}`}
        </Button>
      </div>
      {!projectId && <p className="text-xs text-muted-foreground">Choose a target project to continue.</p>}
    </form>
  );
}

/** OAuth providers: collect start settings, then hand over to the provider's consent screen. */
export function OAuthStartForm({ provider, projectId, idPrefix = "oauth" }: { provider: ProviderInfo; projectId: string | undefined; idPrefix?: string }) {
  const [values, setValues] = useState<FieldValues>(() => {
    const init: FieldValues = {};
    for (const f of provider.startFields) if (f.type === "select" && f.options?.[0]) init[f.key] = f.options[0].value;
    return init;
  });
  const [leaving, setLeaving] = useState(false);

  if (!provider.configured) {
    return (
      <p role="status" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        {provider.name} isn&apos;t configured on this Beacon deployment yet. An administrator needs to register a {provider.name} OAuth app and set{" "}
        <code className="rounded bg-muted px-1">{provider.provider}_CLIENT_ID</code> and{" "}
        <code className="rounded bg-muted px-1">{provider.provider}_CLIENT_SECRET</code>.
      </p>
    );
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!projectId || missingRequired(provider.startFields, values)) return;
    setLeaving(true);
    window.location.assign(buildOAuthStartUrl(provider, projectId, values));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {provider.startFields.length > 0 && (
        <FieldInputs
          fields={provider.startFields}
          values={values}
          onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
          idPrefix={`${idPrefix}-${provider.provider.toLowerCase()}`}
          disabled={leaving}
        />
      )}
      <p className="text-xs text-muted-foreground">
        You&apos;ll be sent to {provider.name} to approve access, then returned here. The first sync starts automatically.
      </p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!projectId || missingRequired(provider.startFields, values) || leaving}>
          {leaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Continue to {provider.name}
        </Button>
      </div>
      {!projectId && <p className="text-xs text-muted-foreground">Choose a target project to continue.</p>}
    </form>
  );
}
