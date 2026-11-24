"use client";

/**
 * Workflow builder: trigger picker, condition rows and action rows whose forms
 * are generated from the per-action schemas. Validates client-side with the
 * same zod schemas the server enforces, then creates or updates the workflow.
 */
import { useId, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ErrorState, LoadingState } from "@/components/ui/states";
import {
  ACTION_META,
  ACTION_TYPES,
  actionSchema,
  CONDITION_OPERATORS,
  eventFields,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  normalizeTriggerEvent,
  OPERATOR_LABELS,
  placeholdersFor,
  RECOMMENDATION_ACTIONS,
  selfTriggerProblem,
  TRIGGER_EVENT_TYPES,
  TRIGGER_EVENTS,
  triggerSchema,
  type ActionType,
  type ConditionOperator,
  type TriggerEvent,
  type WorkflowCondition,
} from "@/server/workflows/definitions";
import { getWorkflowTemplate } from "@/server/workflows/templates";
import { ActionParamsForm, defaultParams } from "./action-params-form";

interface ConditionRow {
  key: number;
  field: string;
  operator: ConditionOperator;
  value: string;
}

interface ActionRow {
  key: number;
  type: ActionType;
  params: Record<string, unknown>;
}

export interface WorkflowDraft {
  name: string;
  description: string;
  trigger: { event: string | null; conditions: unknown[] };
  actions: unknown[];
  enabled: boolean;
}

const selectClass =
  "flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950";

let seq = 1;
const nextKey = () => seq++;

function conditionToRow(raw: unknown): ConditionRow | null {
  const c = raw as Partial<WorkflowCondition> | null;
  if (!c || typeof c.field !== "string" || !CONDITION_OPERATORS.includes(c.operator as ConditionOperator)) return null;
  const v = c.value;
  const value =
    c.operator === "exists" ? (v === false ? "absent" : "present") : Array.isArray(v) ? v.join(", ") : v === undefined ? "" : String(v);
  return { key: nextKey(), field: c.field, operator: c.operator as ConditionOperator, value };
}

function actionToRow(raw: unknown): ActionRow | null {
  const a = raw as { type?: unknown; params?: unknown } | null;
  if (!a || typeof a.type !== "string" || !(ACTION_TYPES as string[]).includes(a.type)) return null;
  return { key: nextKey(), type: a.type as ActionType, params: { ...((a.params as Record<string, unknown>) ?? {}) } };
}

function coerce(v: string, type: string | undefined): string | number | boolean {
  const t = v.trim();
  if (type === "number" && t !== "" && Number.isFinite(Number(t))) return Number(t);
  if (type === "boolean" && (t === "true" || t === "false")) return t === "true";
  return t;
}

function rowToCondition(row: ConditionRow, fieldType: string | undefined): unknown {
  switch (row.operator) {
    case "exists":
      return { field: row.field, operator: "exists", value: row.value !== "absent" };
    case "gt":
    case "lt":
      return { field: row.field, operator: row.operator, value: row.value.trim() === "" ? undefined : Number(row.value) };
    case "in":
      return {
        field: row.field,
        operator: "in",
        value: row.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => coerce(s, fieldType))
          .filter((x): x is string | number => typeof x !== "boolean"),
      };
    case "contains":
      return { field: row.field, operator: "contains", value: row.value.trim() };
    default:
      return { field: row.field, operator: row.operator, value: row.value.trim() === "" ? undefined : coerce(row.value, fieldType) };
  }
}

function issuesByField(issues: Array<{ path: PropertyKey[]; message: string }>, depth: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.length > depth ? String(i.path[depth]) : "_";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

export function WorkflowBuilder({
  mode,
  workflowId,
  projectId: fixedProjectId,
  initial,
  templateId,
  readOnly,
  onSaved,
}: {
  mode: "create" | "edit";
  workflowId?: string;
  projectId?: string;
  initial?: WorkflowDraft;
  templateId?: string;
  readOnly?: boolean;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const uid = useId();
  const template = templateId ? getWorkflowTemplate(templateId) : undefined;
  const start: WorkflowDraft =
    initial ??
    (template
      ? { name: template.name, description: template.description, trigger: template.trigger, actions: template.actions, enabled: true }
      : { name: "", description: "", trigger: { event: "recommendation.created", conditions: [] }, actions: [], enabled: true });

  const [projectId, setProjectId] = useState(fixedProjectId ?? "");
  const [name, setName] = useState(start.name);
  const [description, setDescription] = useState(start.description);
  const [enabled, setEnabled] = useState(start.enabled);
  const [event, setEvent] = useState<TriggerEvent>(normalizeTriggerEvent(start.trigger.event) ?? "recommendation.created");
  const [conditions, setConditions] = useState<ConditionRow[]>(() =>
    start.trigger.conditions.map(conditionToRow).filter((r): r is ConditionRow => r !== null)
  );
  const [actions, setActions] = useState<ActionRow[]>(() => {
    const rows = start.actions.map(actionToRow).filter((r): r is ActionRow => r !== null);
    return rows.length ? rows : [{ key: nextKey(), type: "NOTIFY_SLACK", params: defaultParams("NOTIFY_SLACK") }];
  });
  const [errors, setErrors] = useState<{ form?: string; name?: string; project?: string; trigger?: string; conditions: Record<number, string>; actions: Record<number, Record<string, string>> }>({
    conditions: {},
    actions: {},
  });

  const projects = trpc.project.list.useQuery({ limit: 100 }, { enabled: mode === "create" });
  const options = trpc.workflow.formOptions.useQuery({ projectId }, { enabled: !!projectId });

  const fields = useMemo(() => eventFields(event), [event]);
  const placeholders = useMemo(() => placeholdersFor(event), [event]);

  const create = trpc.workflow.create.useMutation({
    onSuccess: async (res) => {
      toast.success("Workflow created");
      await utils.workflow.list.invalidate();
      router.push(`/workflows/${res.id}`);
    },
  });
  const update = trpc.workflow.update.useMutation({
    onSuccess: async () => {
      toast.success("Workflow saved");
      await Promise.all([utils.workflow.get.invalidate({ id: workflowId! }), utils.workflow.list.invalidate()]);
      onSaved?.();
    },
  });
  const saving = create.isPending || update.isPending;

  function validate() {
    const next: typeof errors = { conditions: {}, actions: {} };
    if (!name.trim()) next.name = "Name is required";
    if (mode === "create" && !projectId) next.project = "Choose a project";
    const builtConditions = conditions.map((row) => rowToCondition(row, fields.find((f) => f.name === row.field)?.type));
    const trigger = triggerSchema.safeParse({ event, conditions: builtConditions });
    if (!trigger.success) {
      for (const issue of trigger.error.issues) {
        if (issue.path[0] === "conditions" && typeof issue.path[1] === "number") next.conditions[conditions[issue.path[1]].key] ??= issue.message;
        else next.trigger ??= issue.message;
      }
    }
    const builtActions = actions.map((row) => {
      const parsed = actionSchema.safeParse({ type: row.type, params: row.params });
      if (!parsed.success) next.actions[row.key] = issuesByField(parsed.error.issues, 1);
      return { type: row.type, params: row.params };
    });
    if (actions.length === 0) next.form = "Add at least one action";
    const loop = selfTriggerProblem(event, actions);
    if (loop) next.form = loop;
    const carriesRec = fields.some((f) => f.name === "recommendationId");
    for (const row of actions) {
      if (RECOMMENDATION_ACTIONS.has(row.type) && !row.params.recommendationId && !carriesRec) {
        next.actions[row.key] = { ...(next.actions[row.key] ?? {}), recommendationId: "This trigger has no recommendation, so choose one" };
      }
    }
    setErrors(next);
    const ok = !next.form && !next.name && !next.project && !next.trigger && !Object.keys(next.conditions).length && !Object.keys(next.actions).length;
    return ok ? { trigger: { event, conditions: builtConditions }, actions: builtActions } : null;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const built = validate();
    if (!built) return;
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      trigger: built.trigger as never,
      actions: built.actions as never,
      enabled,
    };
    if (mode === "create") create.mutate({ projectId, ...payload });
    else update.mutate({ id: workflowId!, ...payload, description: description.trim() || null });
  }

  const missingIntegrations = [...new Set(actions.map((a) => ACTION_META[a.type].requires).filter((r): r is "SLACK" | "JIRA" | "LINEAR" => !!r))].filter(
    (p) => options.data && !options.data.connected[p]
  );

  return (
    <form onSubmit={submit} className="space-y-6" noValidate aria-busy={saving}>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {mode === "create" && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${uid}-project`}>Project</Label>
              {projects.isLoading ? (
                <LoadingState rows={1} label="Loading projects" />
              ) : projects.isError ? (
                <ErrorState message={projects.error.message} onRetry={() => void projects.refetch()} />
              ) : projects.data && projects.data.items.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  You need a project first. <Link className="underline" href="/projects">Create a project</Link>.
                </p>
              ) : (
                <select
                  id={`${uid}-project`}
                  className={selectClass}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  aria-invalid={!!errors.project}
                  aria-describedby={errors.project ? `${uid}-project-error` : undefined}
                >
                  <option value="">Choose a project…</option>
                  {projects.data?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
              {errors.project && (
                <p id={`${uid}-project-error`} role="alert" className="text-xs text-red-600">
                  {errors.project}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>Name</Label>
            <Input
              id={`${uid}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? `${uid}-name-error` : undefined}
              disabled={readOnly}
            />
            {errors.name && (
              <p id={`${uid}-name-error`} role="alert" className="text-xs text-red-600">
                {errors.name}
              </p>
            )}
          </div>
          <div className="flex items-end gap-3 pb-2">
            <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
            <Label htmlFor={`${uid}-enabled`}>Enabled</Label>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${uid}-description`}>
              Description <span className="font-normal text-gray-500">(optional)</span>
            </Label>
            <Textarea id={`${uid}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} disabled={readOnly} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">When</CardTitle>
          <CardDescription>The event that starts this workflow, and optional conditions on its data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-event`}>Trigger event</Label>
            <select
              id={`${uid}-event`}
              className={selectClass}
              value={event}
              onChange={(e) => setEvent(e.target.value as TriggerEvent)}
              disabled={readOnly}
              aria-describedby={`${uid}-event-help`}
            >
              {TRIGGER_EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_EVENTS[t].label}
                </option>
              ))}
            </select>
            <p id={`${uid}-event-help`} className="text-xs text-gray-500 dark:text-gray-400">
              {TRIGGER_EVENTS[event].description}
            </p>
            {errors.trigger && (
              <p role="alert" className="text-xs text-red-600">
                {errors.trigger}
              </p>
            )}
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Conditions</legend>
            {conditions.length === 0 && <p className="text-sm text-gray-500">No conditions: the workflow runs for every event of this type.</p>}
            {conditions.map((row, i) => {
              const fieldId = `${uid}-c${row.key}`;
              const patchRow = (patch: Partial<ConditionRow>) => setConditions((cs) => cs.map((c) => (c.key === row.key ? { ...c, ...patch } : c)));
              const knownFields = fields.some((f) => f.name === row.field) ? fields : [...fields, { name: row.field, type: "string" as const }];
              return (
                <div key={row.key} className="space-y-1">
                  <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <div>
                      <Label htmlFor={`${fieldId}-field`} className="sr-only">
                        Condition {i + 1} field
                      </Label>
                      <select id={`${fieldId}-field`} className={selectClass} value={row.field} onChange={(e) => patchRow({ field: e.target.value })} disabled={readOnly}>
                        <option value="">Field…</option>
                        {knownFields.filter((f) => f.name).map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor={`${fieldId}-op`} className="sr-only">
                        Condition {i + 1} operator
                      </Label>
                      <select id={`${fieldId}-op`} className={selectClass} value={row.operator} onChange={(e) => patchRow({ operator: e.target.value as ConditionOperator, value: e.target.value === "exists" ? "present" : row.value })} disabled={readOnly}>
                        {CONDITION_OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {OPERATOR_LABELS[op]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label htmlFor={`${fieldId}-value`} className="sr-only">
                        Condition {i + 1} value
                      </Label>
                      {row.operator === "exists" ? (
                        <select id={`${fieldId}-value`} className={selectClass} value={row.value} onChange={(e) => patchRow({ value: e.target.value })} disabled={readOnly}>
                          <option value="present">present</option>
                          <option value="absent">absent</option>
                        </select>
                      ) : (
                        <Input
                          id={`${fieldId}-value`}
                          value={row.value}
                          onChange={(e) => patchRow({ value: e.target.value })}
                          placeholder={row.operator === "in" ? "Comma-separated values" : row.operator === "gt" || row.operator === "lt" ? "Number" : "Value"}
                          inputMode={row.operator === "gt" || row.operator === "lt" ? "decimal" : undefined}
                          maxLength={500}
                          aria-invalid={!!errors.conditions[row.key]}
                          disabled={readOnly}
                        />
                      )}
                    </div>
                    {!readOnly && (
                      <Button variant="ghost" size="icon" aria-label={`Remove condition ${i + 1}`} onClick={() => setConditions((cs) => cs.filter((c) => c.key !== row.key))}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                  {errors.conditions[row.key] && (
                    <p role="alert" className="text-xs text-red-600">
                      {errors.conditions[row.key]}
                    </p>
                  )}
                </div>
              );
            })}
            {!readOnly && conditions.length < MAX_CONDITIONS && (
              <Button variant="outline" size="sm" onClick={() => setConditions((cs) => [...cs, { key: nextKey(), field: fields[0]?.name ?? "", operator: "eq", value: "" }])}>
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Add condition
              </Button>
            )}
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Then</CardTitle>
          <CardDescription>Actions run in order. A failed action doesn&apos;t stop the ones after it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {missingIntegrations.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <p>
                {missingIntegrations.map((p) => p.charAt(0) + p.slice(1).toLowerCase()).join(", ")} {missingIntegrations.length === 1 ? "isn't" : "aren't"} connected for this
                workspace, so {missingIntegrations.length === 1 ? "that action" : "those actions"} will fail until you connect{" "}
                <Link href="/integrations" className="underline">
                  integrations
                </Link>
                .
              </p>
            </div>
          )}
          {actions.map((row, i) => {
            const typeId = `${uid}-a${row.key}-type`;
            const rowErrors = errors.actions[row.key] ?? {};
            const move = (dir: -1 | 1) =>
              setActions((as) => {
                const next = [...as];
                const j = i + dir;
                [next[i], next[j]] = [next[j], next[i]];
                return next;
              });
            return (
              <section key={row.key} aria-labelledby={`${typeId}-heading`} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[14rem] flex-1 space-y-1.5">
                    <h3 id={`${typeId}-heading`} className="text-sm font-semibold">
                      Action {i + 1}
                    </h3>
                    <Label htmlFor={typeId} className="sr-only">
                      Action {i + 1} type
                    </Label>
                    <select
                      id={typeId}
                      className={selectClass}
                      value={row.type}
                      onChange={(e) => {
                        const type = e.target.value as ActionType;
                        setActions((as) => as.map((a) => (a.key === row.key ? { ...a, type, params: defaultParams(type) } : a)));
                      }}
                      disabled={readOnly}
                    >
                      {ACTION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {ACTION_META[t].label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!readOnly && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Move action ${i + 1} up`} disabled={i === 0} onClick={() => move(-1)}>
                        <ArrowUp className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Move action ${i + 1} down`} disabled={i === actions.length - 1} onClick={() => move(1)}>
                        <ArrowDown className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={`Remove action ${i + 1}`} onClick={() => setActions((as) => as.filter((a) => a.key !== row.key))}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{ACTION_META[row.type].description}</p>
                <ActionParamsForm
                  type={row.type}
                  params={row.params}
                  onChange={(params) => setActions((as) => as.map((a) => (a.key === row.key ? { ...a, params } : a)))}
                  errors={rowErrors}
                  options={options.data}
                  placeholders={placeholders}
                  idPrefix={`${uid}-a${row.key}`}
                  disabled={readOnly}
                />
                {rowErrors._ && (
                  <p role="alert" className="text-xs text-red-600">
                    {rowErrors._}
                  </p>
                )}
              </section>
            );
          })}
          {!readOnly && actions.length < MAX_ACTIONS && (
            <Button variant="outline" size="sm" onClick={() => setActions((as) => [...as, { key: nextKey(), type: "ALERT_TEAM", params: defaultParams("ALERT_TEAM") }])}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> Add action
            </Button>
          )}
        </CardContent>
      </Card>

      {errors.form && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {errors.form}
        </p>
      )}

      {!readOnly && (
        <div className="flex justify-end gap-2">
          {mode === "create" && (
            <Button variant="outline" asChild>
              <Link href="/workflows">Cancel</Link>
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : mode === "create" ? "Create workflow" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
