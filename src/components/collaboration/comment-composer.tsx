"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { editableToTokens } from "./comment-content";

const MAX_LENGTH = 5000;
const TRIGGER_RE = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u;

interface CommentComposerProps {
  projectId: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  initialText?: string;
  initialMentions?: Array<{ id: string; name: string }>;
  pending?: boolean;
  autoFocus?: boolean;
  onSubmit: (content: string) => Promise<boolean>;
  onCancel?: () => void;
}

/**
 * Comment input with an @mention picker. Picked members are shown as "@Name"
 * and sent as mention tokens, which the server resolves to org members only.
 */
export function CommentComposer({
  projectId,
  label,
  placeholder,
  submitLabel,
  initialText = "",
  initialMentions = [],
  pending,
  autoFocus,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [mentions, setMentions] = useState(initialMentions);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const candidates = trpc.collaboration.mentionCandidates.useQuery(
    { projectId, query: query ?? undefined, limit: 8 },
    { enabled: query !== null, staleTime: 60_000 }
  );
  const options = query !== null ? (candidates.data ?? []) : [];
  const listboxId = `${id}-mentions`;

  const updateTrigger = (value: string, caret: number) => {
    const m = TRIGGER_RE.exec(value.slice(0, caret));
    setQuery(m ? m[2] : null);
    setHighlight(0);
  };

  const pick = (option: { id: string; name: string }) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(TRIGGER_RE, (_all, lead: string) => `${lead}@${option.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentions((prev) => (prev.some((p) => p.id === option.id) ? prev : [...prev, { id: option.id, name: option.name }]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    const ok = await onSubmit(editableToTokens(trimmed, mentions));
    if (ok) {
      setText("");
      setMentions([]);
      setQuery(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0 && query !== null) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[Math.min(highlight, options.length - 1)]);
        return;
      }
    }
    if (e.key === "Escape" && query !== null) {
      e.preventDefault();
      setQuery(null);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const tooLong = text.length > MAX_LENGTH;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor={`${id}-input`} className="sr-only">
        {label}
      </Label>
      <div className="relative">
        <Textarea
          id={`${id}-input`}
          ref={textareaRef}
          value={text}
          placeholder={placeholder ?? "Write a comment… Type @ to mention a teammate"}
          rows={3}
          autoFocus={autoFocus}
          aria-invalid={tooLong}
          aria-autocomplete="list"
          aria-controls={query !== null ? listboxId : undefined}
          aria-expanded={query !== null && options.length > 0}
          aria-activedescendant={query !== null && options.length > 0 ? `${listboxId}-${highlight}` : undefined}
          role="combobox"
          onChange={(e) => {
            setText(e.target.value);
            updateTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setQuery(null), 150)}
        />
        {query !== null && options.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Mention a teammate"
            className="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          >
            {options.map((o, i) => (
              <li
                key={o.id}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                className={cn("cursor-pointer px-3 py-1.5 text-sm", i === highlight && "bg-accent text-accent-foreground")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="font-medium">{o.name}</span>
                {o.handle && <span className="ml-2 text-xs text-muted-foreground">@{o.handle}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
          {tooLong ? `${text.length - MAX_LENGTH} characters over the limit` : "Ctrl/⌘ + Enter to send"}
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={pending || !text.trim() || tooLong}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
