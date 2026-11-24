/**
 * Churn "AI risk assessment" per customer account.
 *
 * This is an LLM judgement from explicit, listed signals, not a statistical
 * prediction: rows are stored with methodology "AI_RISK_ASSESSMENT" and the UI
 * labels them that way. Computed signals (volume, negative share, explicit
 * churn statements) are always included alongside the model's signals, and
 * any evidence quote the model gives must occur in that account's feedback.
 */
import type { RiskLevel } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "@/lib/logger";
import { generateObject, LLMError } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";
import { verifyQuote } from "../knowledge/text";
import type { ChunkSentiment } from "./classify";
import type { CustomerIdentity } from "./customers";

export const CHURN_FEATURE = "sentiment.churn";
export const CHURN_METHODOLOGY = "AI_RISK_ASSESSMENT";
export const MAX_ACCOUNTS_PER_RUN = 30;
const ACCOUNTS_PER_CALL = 10;
const EXCERPTS_PER_ACCOUNT = 4;
const EXCERPT_CHARS = 700;

export interface AccountItem extends ChunkSentiment {
  content: string;
}

export interface AccountGroup {
  identity: CustomerIdentity;
  items: AccountItem[];
}

export interface RiskSignal {
  source: "computed" | "ai";
  label: string;
  detail: string | null;
  weight: "LOW" | "MEDIUM" | "HIGH";
}

export interface AccountAssessment {
  customerId: string;
  customerName: string;
  segment: string | null;
  churnProbability: number;
  riskLevel: RiskLevel;
  confidence: number;
  signals: RiskSignal[];
  recommendations: string[];
}

const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const schema = z.object({
  assessments: z.array(
    z.object({
      ref: z.string().describe("Account label, e.g. A2"),
      riskScore: z.number().describe("0 to 1: assessed likelihood the account churns or downgrades"),
      riskLevel: z.enum(RISK_LEVELS),
      signals: z.array(
        z.object({
          label: z.string().describe("Short name of the risk or retention signal"),
          evidence: z.string().nullable().describe("Verbatim quote from that account's feedback, or null"),
          weight: z.enum(["LOW", "MEDIUM", "HIGH"]),
        })
      ),
      recommendations: z.array(z.string()).describe("Up to 3 concrete retention actions"),
      confidence: z.number().describe("0 to 1: how much evidence supports this assessment"),
    })
  ),
});

const SYSTEM = `You assess churn risk for customer accounts of a software product, for a product team.
For each labelled account you get computed statistics and a few verbatim feedback excerpts.
Give a risk score from 0 to 1, a risk level, the specific signals behind it (quote the excerpt verbatim when you cite evidence), up to three concrete retention actions, and your confidence.
Base the assessment only on the material provided. Little or ambiguous evidence means low confidence, not high risk.

${UNTRUSTED_DATA_POLICY}`;

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function computedSignals(items: AccountItem[]): RiskSignal[] {
  const n = items.length;
  const neg = items.filter((i) => i.label === "NEGATIVE").length;
  const avg = n > 0 ? items.reduce((a, b) => a + b.score, 0) / n : 0;
  const explicit = [...new Set(items.flatMap((i) => i.churnSignals))];
  const out: RiskSignal[] = [
    {
      source: "computed",
      label: "Feedback analysed",
      detail: `${n} item(s), average sentiment ${avg.toFixed(2)}`,
      weight: "LOW",
    },
  ];
  if (n > 0 && neg / n >= 0.25) {
    out.push({ source: "computed", label: "Negative feedback share", detail: `${neg} of ${n} items negative (${pct(neg / n)})`, weight: neg / n >= 0.6 ? "HIGH" : "MEDIUM" });
  }
  if (explicit.length > 0) {
    out.push({
      source: "computed",
      label: "Explicit churn statements",
      detail: explicit.slice(0, 3).join("; ").slice(0, 400),
      weight: explicit.length >= 2 ? "HIGH" : "MEDIUM",
    });
  }
  return out;
}

/** Accounts worth assessing, highest apparent risk first, capped. */
export function selectAccounts(groups: AccountGroup[]): AccountGroup[] {
  const score = (g: AccountGroup) => {
    const n = g.items.length;
    const neg = g.items.filter((i) => i.label === "NEGATIVE").length / Math.max(1, n);
    const explicit = g.items.reduce((a, i) => a + i.churnSignals.length, 0);
    return { explicit, neg, n };
  };
  return groups
    .filter((g) => g.items.length >= 2 || g.items.some((i) => i.churnSignals.length > 0))
    .map((g) => ({ g, s: score(g) }))
    .sort((a, b) => b.s.explicit - a.s.explicit || b.s.neg - a.s.neg || b.s.n - a.s.n || a.g.identity.customerId.localeCompare(b.g.identity.customerId))
    .slice(0, MAX_ACCOUNTS_PER_RUN)
    .map((x) => x.g);
}

function excerpts(items: AccountItem[]): AccountItem[] {
  // Most negative and signal-bearing items first.
  return [...items].sort((a, b) => b.churnSignals.length - a.churnSignals.length || a.score - b.score).slice(0, EXCERPTS_PER_ACCOUNT);
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export interface ChurnResult {
  assessments: AccountAssessment[];
  /** Accounts the model returned no usable assessment for. */
  failedAccounts: number;
  /** True when every call failed (previous assessments should be kept). */
  allFailed: boolean;
}

export async function assessAccounts(groups: AccountGroup[], ctx: { orgId: string; projectId: string; windowLabel: string }, log: Logger): Promise<ChurnResult> {
  const selected = selectAccounts(groups);
  const assessments: AccountAssessment[] = [];
  let failedAccounts = 0;
  let calls = 0;
  let failedCalls = 0;

  for (let i = 0; i < selected.length; i += ACCOUNTS_PER_CALL) {
    const slice = selected.slice(i, i + ACCOUNTS_PER_CALL);
    const blocks = slice.map((g, k) => {
      const n = g.items.length;
      const neg = g.items.filter((x) => x.label === "NEGATIVE").length;
      const avg = g.items.reduce((a, b) => a + b.score, 0) / Math.max(1, n);
      const themes = [...new Set(g.items.flatMap((x) => x.themes))].slice(0, 8);
      const stats = `A${k + 1}: ${n} feedback item(s) in ${ctx.windowLabel}; ${neg} negative; average sentiment ${avg.toFixed(2)}; segment ${g.identity.segment ?? "unknown"}.`;
      const ex = excerpts(g.items).map((x, j) => untrusted(`A${k + 1} excerpt ${j + 1}`, x.content.slice(0, EXCERPT_CHARS)));
      const named = untrusted(`A${k + 1} account name and themes`, `Account: ${g.identity.customerName}\nThemes: ${themes.join(", ") || "none"}\nStated churn signals: ${[...new Set(g.items.flatMap((x) => x.churnSignals))].slice(0, 5).join("; ") || "none"}`);
      return [stats, named, ...ex].join("\n");
    });
    calls++;
    try {
      const raw = await generateObject({
        feature: CHURN_FEATURE,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        system: SYSTEM,
        prompt: `Assess these ${slice.length} accounts.\n\n${blocks.join("\n\n---\n\n")}`,
        schema,
        maxTokens: 8_000,
        effort: "medium",
      });
      const byRef = new Map(raw.assessments.map((a) => [a.ref.trim().toLowerCase(), a]));
      slice.forEach((g, k) => {
        const a = byRef.get(`a${k + 1}`);
        if (!a) {
          failedAccounts++;
          return;
        }
        const corpus = g.items.map((x) => x.content).join("\n");
        const aiSignals: RiskSignal[] = a.signals.slice(0, 6).map((s) => ({
          source: "ai",
          label: s.label.replace(/\s+/g, " ").trim().slice(0, 120) || "Signal",
          detail: s.evidence ? verifyQuote(s.evidence, corpus) : null,
          weight: s.weight,
        }));
        assessments.push({
          customerId: g.identity.customerId,
          customerName: g.identity.customerName,
          segment: g.identity.segment,
          churnProbability: Math.round(clamp01(a.riskScore) * 1000) / 1000,
          riskLevel: a.riskLevel,
          confidence: Math.round(clamp01(a.confidence) * 1000) / 1000,
          signals: [...computedSignals(g.items), ...aiSignals],
          recommendations: a.recommendations.map((r) => r.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(0, 3),
        });
      });
    } catch (err) {
      if (!(err instanceof LLMError)) throw err;
      failedCalls++;
      failedAccounts += slice.length;
      log.warn("churn assessment batch failed", { reason: err.reason, accounts: slice.length });
    }
  }
  return { assessments, failedAccounts, allFailed: calls > 0 && failedCalls === calls };
}
