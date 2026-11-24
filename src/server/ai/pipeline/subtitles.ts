/**
 * WebVTT / SubRip parsing into speaker turns.
 *
 * Cue numbers, timing lines, NOTE/STYLE/REGION blocks and inline markup are
 * removed. Speakers come from WebVTT voice spans (<v Alice>) or a "Name:" prefix.
 * Consecutive cues from the same speaker are merged into one turn, and the
 * repeated lines that rolling auto-captions produce are dropped. Timestamps are
 * kept as turn metadata (start seconds), not in the text.
 */

export interface SpeakerTurn {
  speaker: string | null;
  startSec: number | null;
  text: string;
}

const TIMING = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function toSeconds(ts: string): number {
  const parts = ts.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const SPEAKER_PREFIX = /^([A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}|Speaker \d+|Interviewer|Interviewee|Customer|Agent|Host|Guest|Q|A)\s*:\s+(.+)$/;

function cleanCueText(line: string): { speaker: string | null; text: string } {
  let speaker: string | null = null;
  const voice = line.match(/<v(?:\.[^\s>]+)*\s+([^>]+)>/i);
  if (voice) speaker = voice[1].trim();
  let text = line
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, "") // karaoke timestamps
    .replace(/<\/?[a-z][^>]*>/gi, "") // markup (<v>, <c>, <i>, <b>, <u>, <font>, <lang>)
    .replace(/\{\\[^}]*\}/g, "") // SSA-style override tags sometimes found in SRT
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!speaker) {
    const m = text.match(SPEAKER_PREFIX);
    if (m) {
      speaker = m[1].trim();
      text = m[2].trim();
    }
  }
  text = text.replace(/^[-–]\s+/, "");
  return { speaker, text };
}

/** Parse VTT or SRT content into merged speaker turns. */
export function parseSubtitles(input: string): SpeakerTurn[] {
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const turns: SpeakerTurn[] = [];
  let lastLine = "";

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.length === 0) continue;
    const first = lines[0].trim();
    if (/^WEBVTT\b/.test(first) || /^(NOTE|STYLE|REGION)\b/.test(first)) continue;

    const timingIdx = lines.findIndex((l) => TIMING.test(l));
    if (timingIdx < 0) continue; // not a cue (stray header or garbage)
    const startSec = toSeconds(lines[timingIdx].match(TIMING)![1]);

    for (const raw of lines.slice(timingIdx + 1)) {
      if (!raw.trim()) continue;
      const { speaker, text: cueText } = cleanCueText(raw);
      if (!cueText || cueText === lastLine) continue;
      lastLine = cueText;
      const prev = turns[turns.length - 1];
      if (prev && (speaker === null || speaker === prev.speaker)) {
        prev.text = `${prev.text} ${cueText}`;
      } else {
        turns.push({ speaker, startSec, text: cueText });
      }
    }
  }
  return turns;
}
