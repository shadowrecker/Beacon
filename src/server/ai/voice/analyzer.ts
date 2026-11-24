/**
 * Voice insight extraction from a transcript (generateObject). The transcript
 * is customer speech: it enters the prompt only through untrusted(). Output is
 * clamped and length-capped before storage.
 */
import { z } from "zod";
import { generateObject } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";

export const voiceAnalysisSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  painPoints: z.array(z.string()),
  actionItems: z.array(z.string()),
  questions: z.array(z.string()),
  sentimentScore: z.number(),
  themes: z.array(z.string()),
  suggestedFollowUps: z.array(z.string()),
});
export type VoiceAnalysis = z.infer<typeof voiceAnalysisSchema>;

const SYSTEM = `You analyze recorded customer conversations and voice notes for a product team.

From the transcript, extract:
- summary: 2-4 sentences on what the conversation was about and what the customer needs.
- keyPoints: the most important statements (max 8).
- painPoints: problems, frustrations or unmet needs the customer expressed (max 8).
- actionItems: concrete follow-ups the team committed to or should take (max 8).
- questions: questions the customer asked (max 8).
- sentimentScore: overall customer sentiment from -1 (very negative) to 1 (very positive).
- themes: 2-6 short product themes (2-4 words each).
- suggestedFollowUps: questions worth asking in a next conversation (max 5).

Only use what is in the transcript. Speakers are labelled "Speaker N" when there are several.

${UNTRUSTED_DATA_POLICY}`;

export const MAX_TRANSCRIPT_CHARS = 120_000;

const clipList = (items: string[], max: number, len = 400) =>
  items.map((s) => s.replace(/\s+/g, " ").trim().slice(0, len)).filter(Boolean).slice(0, max);

export interface AnalysisResult {
  analysis: VoiceAnalysis;
  analyzedChars: number;
  totalChars: number;
}

export async function analyzeTranscript(ctx: { orgId: string; projectId: string; title: string }, transcript: string): Promise<AnalysisResult> {
  const analyzed = transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  const truncatedNote =
    analyzed.length < transcript.length
      ? `\n\nNote: only the first ${analyzed.length.toLocaleString("en-US")} of ${transcript.length.toLocaleString("en-US")} characters are included.`
      : "";
  const raw = await generateObject({
    feature: "voice.analyze",
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    system: SYSTEM,
    prompt: `Recording: ${ctx.title.slice(0, 200)}${truncatedNote}\n\n${untrusted("voice transcript", analyzed)}`,
    schema: voiceAnalysisSchema,
    maxTokens: 4_000,
  });
  const score = Number.isFinite(raw.sentimentScore) ? Math.max(-1, Math.min(1, raw.sentimentScore)) : 0;
  return {
    analysis: {
      summary: raw.summary.trim().slice(0, 3_000),
      keyPoints: clipList(raw.keyPoints, 8),
      painPoints: clipList(raw.painPoints, 8),
      actionItems: clipList(raw.actionItems, 8),
      questions: clipList(raw.questions, 8),
      sentimentScore: Math.round(score * 100) / 100,
      themes: clipList(raw.themes, 6, 60),
      suggestedFollowUps: clipList(raw.suggestedFollowUps, 5),
    },
    analyzedChars: analyzed.length,
    totalChars: transcript.length,
  };
}
