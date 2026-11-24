"use client";

import { formatDuration } from "./upload";

export interface Segment {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

const SPEAKER_COLORS = ["text-blue-700 dark:text-blue-300", "text-emerald-700 dark:text-emerald-300", "text-purple-700 dark:text-purple-300", "text-amber-700 dark:text-amber-300"];

/** Diarized transcript as speaker turns (falls back to plain text). */
export function TranscriptView({ segments, text }: { segments: Segment[]; text: string | null }) {
  if (segments.length === 0) {
    return text ? <p className="whitespace-pre-line text-sm leading-relaxed">{text}</p> : <p className="text-sm text-muted-foreground">No transcript yet.</p>;
  }
  const speakers = new Set(segments.map((s) => s.speaker)).size;
  return (
    <ol className="space-y-3">
      {segments.map((s, i) => (
        <li key={i} className="text-sm leading-relaxed">
          <div className="flex items-baseline gap-2">
            {speakers > 1 && <span className={`font-semibold ${SPEAKER_COLORS[s.speaker % SPEAKER_COLORS.length]}`}>Speaker {s.speaker + 1}</span>}
            <time className="font-mono text-xs text-muted-foreground">{formatDuration(s.start)}</time>
          </div>
          <p>{s.text}</p>
        </li>
      ))}
    </ol>
  );
}
