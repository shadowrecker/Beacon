/**
 * Safe evaluation of workflow trigger conditions against an event payload.
 *
 * - Only own, enumerable properties are read (no prototype walking, so
 *   `__proto__`/`constructor` paths resolve to undefined).
 * - No regular expressions are built from user input (`matches` was removed
 *   because user-supplied patterns are a ReDoS vector).
 * - String comparisons are bounded: operands are clipped before `includes`.
 * - Any malformed or unknown condition (for example a legacy definition stored
 *   before validation existed) evaluates to false: fail closed.
 */
import { conditionSchema, MAX_CONDITIONS, type WorkflowCondition } from "./definitions";

const MAX_COMPARE = 10_000;

function own(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export function readPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split(".").slice(0, 5)) {
    cur = own(cur, part);
    if (cur === undefined) return undefined;
  }
  return cur;
}

function clip(v: unknown): string {
  return String(v).slice(0, MAX_COMPARE).toLowerCase();
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
  }
  if (typeof a === "boolean" || typeof b === "boolean") return String(a) === String(b);
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return false;
}

export function evaluateCondition(condition: WorkflowCondition, payload: unknown): boolean {
  const actual = readPath(payload, condition.field);
  const expected = condition.value;
  switch (condition.operator) {
    case "exists": {
      const present = actual !== undefined && actual !== null;
      return expected === false ? !present : present;
    }
    case "eq":
      return looselyEqual(actual, expected);
    case "neq":
      return actual !== undefined && !looselyEqual(actual, expected);
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "contains": {
      if (typeof expected !== "string") return false;
      const needle = clip(expected);
      if (Array.isArray(actual)) return actual.slice(0, 500).some((x) => clip(x) === needle);
      return typeof actual === "string" && clip(actual).includes(needle);
    }
    case "in":
      return Array.isArray(expected) && expected.some((e) => looselyEqual(actual, e));
    default:
      return false;
  }
}

/**
 * True when every condition holds (an empty list always matches). Stored
 * conditions are re-validated first; anything that fails validation (such as a
 * legacy `matches` condition) makes the trigger not match.
 */
export function evaluateConditions(raw: unknown, payload: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (!Array.isArray(raw) || raw.length > MAX_CONDITIONS) return false;
  for (const item of raw) {
    const parsed = conditionSchema.safeParse(item);
    if (!parsed.success) return false;
    if (!evaluateCondition(parsed.data, payload)) return false;
  }
  return true;
}
