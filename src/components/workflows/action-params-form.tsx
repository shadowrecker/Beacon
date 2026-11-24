"use client";

/**
 * Per-action parameter form, generated from the action's zod schema
 * (definitions.ts) via JSON Schema: field types, enums, defaults, limits,
 * titles and descriptions all come from the schema the server enforces. Custom
 * `widget` metadata picks a richer control (member/roadmap/recommendation
 * pickers, recipient groups, message templates).
 */
import { useMemo, type ReactNode } from "react";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ACTION_PARAM_SCHEMAS, ROLE_GROUP_LABELS, ROLE_GROUPS, type ActionType } from "@/server/workflows/definitions";

export interface BuilderOptions {
  members: Array<{ id: string; name: string | null; email: string | null; role: string }>;
  roadmaps: Array<{ id: string; name: string }>;
  recommendations: Array<{ id: string; title: string }>;
}

interface JsonProp {
  type?: string;
  enum?: string[];
  title?: string;
  description?: string;
  maxLength?: number;
  default?: unknown;
  widget?: string;
  anyOf?: JsonProp[];
}

interface JsonObject {
  properties?: Record<string, JsonProp>;
  required?: string[];
}

const schemaCache = new Map<ActionType, JsonObject>();
export function actionJsonSchema(type: ActionType): JsonObject {
  let s = schemaCache.get(type);
  if (!s) {
    s = z.toJSONSchema(ACTION_PARAM_SCHEMAS[type], { io: "input", unrepresentable: "any" }) as JsonObject;
    schemaCache.set(type, s);
  }
  return s;
}

/** Defaults from the schema, used when an action is added or its type changes. */
export function defaultParams(type: ActionType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(actionJsonSchema(type).properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

const selectClass =
  "flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950";

export function ActionParamsForm({
  type,
  params,
  onChange,
  errors,
  options,
  placeholders,
  idPrefix,
  disabled,
}: {
  type: ActionType;
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errors: Record<string, string>;
  options: BuilderOptions | undefined;
  placeholders: string[];
  idPrefix: string;
  disabled?: boolean;
}) {
  const schema = useMemo(() => actionJsonSchema(type), [type]);
  const required = new Set(schema.required ?? []);
  const set = (key: string, value: unknown) => {
    const next = { ...params };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.entries(schema.properties ?? {}).map(([key, prop]) => {
        const id = `${idPrefix}-${key}`;
        const label = prop.title ?? humanize(key);
        const isRequired = required.has(key);
        const error = errors[key];
        const describedBy = [prop.description ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        const value = params[key];
        const wide = prop.widget === "template" || prop.widget === "recipients";
        const enumValues = prop.enum ?? prop.anyOf?.find((p) => p.enum)?.enum;

        let control: ReactNode;
        if (prop.widget === "template") {
          control = (
            <Textarea
              id={id}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => set(key, e.target.value)}
              maxLength={prop.maxLength}
              rows={key === "subject" || key === "title" ? 1 : 3}
              aria-invalid={!!error}
              aria-describedby={describedBy}
              disabled={disabled}
            />
          );
        } else if (prop.widget === "member") {
          control = (
            <select id={id} className={selectClass} value={typeof value === "string" ? value : ""} onChange={(e) => set(key, e.target.value)} aria-invalid={!!error} aria-describedby={describedBy} disabled={disabled}>
              <option value="">Choose a member…</option>
              {options?.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ?? m.email ?? m.id} ({m.role.toLowerCase()})
                </option>
              ))}
            </select>
          );
        } else if (prop.widget === "roadmap" || prop.widget === "recommendation") {
          const items =
            prop.widget === "roadmap"
              ? (options?.roadmaps ?? []).map((r) => ({ id: r.id, label: r.name }))
              : (options?.recommendations ?? []).map((r) => ({ id: r.id, label: r.title }));
          control = (
            <select id={id} className={selectClass} value={typeof value === "string" ? value : ""} onChange={(e) => set(key, e.target.value || undefined)} aria-invalid={!!error} aria-describedby={describedBy} disabled={disabled}>
              <option value="">{prop.widget === "roadmap" ? "Most recent roadmap" : "From the triggering event"}</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          );
        } else if (prop.widget === "recipients") {
          const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
          const toggle = (r: string) => {
            const next = new Set(selected);
            if (next.has(r)) next.delete(r);
            else next.add(r);
            set(key, next.size ? [...next] : undefined);
          };
          control = (
            <fieldset id={id} aria-describedby={describedBy} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2" disabled={disabled}>
              <legend className="sr-only">{label}</legend>
              {ROLE_GROUPS.map((g) => (
                <label key={g} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.has(g)} onChange={() => toggle(g)} className="h-4 w-4" />
                  {ROLE_GROUP_LABELS[g]}
                </label>
              ))}
              {options?.members.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4" />
                  {m.name ?? m.email ?? m.id}
                </label>
              ))}
            </fieldset>
          );
        } else if (enumValues) {
          control = (
            <select id={id} className={selectClass} value={typeof value === "string" ? value : String(prop.default ?? "")} onChange={(e) => set(key, e.target.value)} aria-invalid={!!error} aria-describedby={describedBy} disabled={disabled}>
              {!isRequired && prop.default === undefined && <option value="">Default</option>}
              {enumValues.map((v) => (
                <option key={v} value={v}>
                  {prop.widget === "roleGroup" && v in ROLE_GROUP_LABELS ? ROLE_GROUP_LABELS[v as keyof typeof ROLE_GROUP_LABELS] : v}
                </option>
              ))}
            </select>
          );
        } else if (prop.type === "boolean") {
          control = (
            <div className="flex h-10 items-center">
              <Switch id={id} checked={value === true} onCheckedChange={(c) => set(key, c)} aria-describedby={describedBy} disabled={disabled} />
            </div>
          );
        } else {
          control = (
            <Input
              id={id}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => set(key, e.target.value.trim() === "" ? undefined : e.target.value)}
              maxLength={prop.maxLength}
              aria-invalid={!!error}
              aria-describedby={describedBy}
              disabled={disabled}
            />
          );
        }

        return (
          <div key={key} className={wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={id}>
              {label}
              {isRequired ? <span aria-hidden className="text-red-600"> *</span> : <span className="font-normal text-gray-500"> (optional)</span>}
            </Label>
            {control}
            {prop.description && (
              <p id={`${id}-help`} className="text-xs text-gray-500 dark:text-gray-400">
                {prop.description}
                {prop.widget === "template" && placeholders.length > 0 && (
                  <>
                    {" "}
                    Available: {placeholders.map((p) => `{{${p}}}`).join(", ")}.
                  </>
                )}
              </p>
            )}
            {error && (
              <p id={`${id}-error`} className="text-xs text-red-600" role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
