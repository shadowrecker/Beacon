/** Display metadata for knowledge-graph entity and relation types. */
export const ENTITY_TYPES = [
  "PERSON",
  "COMPANY",
  "PRODUCT",
  "FEATURE",
  "CONCEPT",
  "PAIN_POINT",
  "PERSONA",
  "COMPETITOR",
  "USE_CASE",
] as const;
export type EntityTypeName = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_COLORS: Record<EntityTypeName, string> = {
  PERSON: "#3b82f6",
  COMPANY: "#a855f7",
  PRODUCT: "#10b981",
  FEATURE: "#f59e0b",
  CONCEPT: "#6b7280",
  PAIN_POINT: "#ef4444",
  PERSONA: "#ec4899",
  COMPETITOR: "#f97316",
  USE_CASE: "#14b8a6",
};

export function typeLabel(type: string): string {
  const s = type.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function colorFor(type: string): string {
  return ENTITY_TYPE_COLORS[type as EntityTypeName] ?? "#6b7280";
}
