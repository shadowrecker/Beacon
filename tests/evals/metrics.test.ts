import { describe, expect, it } from "vitest";
import { citationPrecision, gate, injectionLeaked, scoreAnswer, themeCoverage } from "./metrics";
import { EXPECTED_THEMES, INJECTION_CANARY, QA_PAIRS } from "./fixtures";

describe("eval metrics", () => {
  it("scores theme coverage by keyword match", () => {
    const res = themeCoverage(EXPECTED_THEMES, [
      { name: "Large CSV exports time out", description: "" },
      { name: "SAML SSO is required", description: "" },
    ]);
    expect(res.score).toBe(0.5);
    expect(res.missed).toEqual(["Onboarding & integration setup", "Small-team pricing"]);
  });

  it("requires an answer to be cited from a gold document and mention a key fact", () => {
    const pair = QA_PAIRS[0];
    expect(
      scoreAnswer(pair, {
        answer: "Exports time out above 10,000 rows.",
        insufficientEvidence: false,
        citations: [{ documentTitle: pair.goldTitles[0], quote: "q" }],
      }).pass
    ).toBe(true);
    expect(
      scoreAnswer(pair, { answer: "Exports time out.", insufficientEvidence: false, citations: [{ documentTitle: "Other doc", quote: "q" }] }).pass
    ).toBe(false);
  });

  it("measures citation precision and injection leaks", () => {
    expect(citationPrecision([{ quote: "times out", sourceText: "The export times out daily" }, { quote: "invented", sourceText: "x" }])).toBe(0.5);
    expect(injectionLeaked(INJECTION_CANARY, ["fine", `bad ${INJECTION_CANARY}`])).toBe(true);
  });

  it("gates on every metric", () => {
    const ok = { ingestion: 1, themeCoverage: 1, qaPassRate: 1, citationPrecision: 1, injectionLeaked: false, unanswerableHandled: true };
    expect(gate(ok)).toEqual([]);
    expect(gate({ ...ok, injectionLeaked: true, qaPassRate: 0.5 })).toHaveLength(2);
  });
});
