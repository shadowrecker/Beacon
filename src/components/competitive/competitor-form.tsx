"use client";

import type { ChangeEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface CompetitorFormValues {
  name: string;
  website: string;
  captureUrl: string;
  g2Url: string;
  description: string;
}

export const EMPTY_COMPETITOR: CompetitorFormValues = { name: "", website: "", captureUrl: "", g2Url: "", description: "" };

/** Client-side check mirroring the server's http(s) allowlist (empty is allowed). */
export function urlError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "Use an http(s) address";
    return null;
  } catch {
    return "Enter a full address, e.g. https://example.com";
  }
}

export function competitorFormErrors(v: CompetitorFormValues): Partial<Record<keyof CompetitorFormValues, string>> {
  const errors: Partial<Record<keyof CompetitorFormValues, string>> = {};
  if (!v.name.trim()) errors.name = "Name is required";
  for (const key of ["website", "captureUrl", "g2Url"] as const) {
    const e = urlError(v[key]);
    if (e) errors[key] = e;
  }
  return errors;
}

export function CompetitorFields({
  idPrefix,
  values,
  onChange,
  errors,
  disabled,
}: {
  idPrefix: string;
  values: CompetitorFormValues;
  onChange: (next: CompetitorFormValues) => void;
  errors: Partial<Record<keyof CompetitorFormValues, string>>;
  disabled?: boolean;
}) {
  const set = (key: keyof CompetitorFormValues) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...values, [key]: e.target.value });
  const field = (key: keyof CompetitorFormValues, label: string, opts: { type?: string; placeholder?: string; help?: string; required?: boolean }) => {
    const id = `${idPrefix}-${key}`;
    const err = errors[key];
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {opts.required && <span aria-hidden> *</span>}
        </Label>
        <Input
          id={id}
          type={opts.type ?? "text"}
          inputMode={opts.type === "url" ? "url" : undefined}
          value={values[key]}
          onChange={set(key)}
          placeholder={opts.placeholder}
          disabled={disabled}
          required={opts.required}
          maxLength={opts.type === "url" ? 2000 : 120}
          aria-invalid={!!err}
          aria-describedby={err ? `${id}-error` : opts.help ? `${id}-help` : undefined}
        />
        {err ? (
          <p id={`${id}-error`} className="text-xs text-destructive">
            {err}
          </p>
        ) : opts.help ? (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {opts.help}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {field("name", "Name", { required: true, placeholder: "Acme Analytics" })}
      {field("website", "Website", {
        type: "url",
        placeholder: "https://acme.com",
        help: "Scans check the homepage plus changelog, blog and pricing pages.",
      })}
      {field("captureUrl", "Extra page to monitor", { type: "url", placeholder: "https://acme.com/product-updates" })}
      {field("g2Url", "G2 page (reference link only)", {
        type: "url",
        placeholder: "https://www.g2.com/products/acme/reviews",
        help: "Review sites aren't scraped. Add review insights as manual updates.",
      })}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-description`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-description`}
          value={values.description}
          onChange={set("description")}
          maxLength={2000}
          rows={3}
          disabled={disabled}
          placeholder="Positioning, target customers, where they win deals…"
        />
      </div>
    </div>
  );
}
