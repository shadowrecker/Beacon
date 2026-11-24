export const SYNTHESIS_TYPES = [
  { value: "FULL", label: "Full synthesis", description: "All themes: problems, requests and positive signals" },
  { value: "PAIN_POINTS", label: "Pain points", description: "Only problems and frustrations" },
  { value: "FEATURE_REQUESTS", label: "Feature requests", description: "Only things customers ask for" },
  { value: "THEMES", label: "Themes", description: "Recurring themes across all feedback" },
] as const;

export type SynthesisTypeValue = (typeof SYNTHESIS_TYPES)[number]["value"];

export const SYNTHESIS_TYPE_LABEL: Record<SynthesisTypeValue, string> = Object.fromEntries(SYNTHESIS_TYPES.map((t) => [t.value, t.label])) as Record<
  SynthesisTypeValue,
  string
>;
