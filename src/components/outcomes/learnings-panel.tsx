"use client";

/**
 * Learning summary: which kinds of recommendations met their targets in this
 * project (the same summary that informs future recommendation scoring).
 */
import { Lightbulb } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";
import { formatPercent, type Learnings } from "./labels";

function GroupTable({ title, groups }: { title: string; groups: Learnings["byImpact"] }) {
  if (groups.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="pb-1 font-normal">Group</th>
            <th scope="col" className="pb-1 text-right font-normal">Met target</th>
            <th scope="col" className="pb-1 text-right font-normal">Success</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-t border-gray-100 dark:border-gray-800">
              <th scope="row" className="py-1 text-left font-normal">{g.label}</th>
              <td className="py-1 text-right">
                {g.met}/{g.measured}
              </td>
              <td className="py-1 text-right font-medium">{formatPercent(g.successRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LearningsPanel({ projectId }: { projectId: string }) {
  const q = trpc.outcome.getLearnings.useQuery({ projectId });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Lightbulb className="h-5 w-5 text-yellow-500" aria-hidden />
          What&apos;s working
        </CardTitle>
        <CardDescription>Measured outcomes in this project, grouped by recommendation impact and confidence. Future recommendations are calibrated with this.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <LoadingState rows={2} label="Loading learnings" />
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : q.data ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Tracked</dt>
                <dd className="text-2xl font-semibold">{q.data.tracked}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Measured</dt>
                <dd className="text-2xl font-semibold">{q.data.measured}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Met target</dt>
                <dd className="text-2xl font-semibold">{formatPercent(q.data.overall.successRate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Decisions logged</dt>
                <dd className="text-2xl font-semibold">{q.data.decisionsLogged}</dd>
              </div>
            </dl>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {q.data.insights.map((i, idx) => (
                <li key={idx}>{i}</li>
              ))}
            </ul>
            {q.data.measured > 0 && (
              <div className="grid gap-6 md:grid-cols-2">
                <GroupTable title="By impact" groups={q.data.byImpact} />
                <GroupTable title="By confidence" groups={q.data.byConfidence} />
              </div>
            )}
            {(q.data.topPerformers.length > 0 || q.data.underperformers.length > 0) && (
              <div className="grid gap-6 md:grid-cols-2">
                {q.data.topPerformers.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Met their target</h4>
                    <ul className="space-y-1 text-sm">
                      {q.data.topPerformers.map((p) => (
                        <li key={p.recommendationId} className="flex justify-between gap-2">
                          <span className="truncate">{p.title}</span>
                          <span className="flex-shrink-0 font-medium text-green-700 dark:text-green-400">{formatPercent(p.progress)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {q.data.underperformers.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Fell short</h4>
                    <ul className="space-y-1 text-sm">
                      {q.data.underperformers.map((p) => (
                        <li key={p.recommendationId} className="flex justify-between gap-2">
                          <span className="truncate">{p.title}</span>
                          <span className="flex-shrink-0 font-medium text-red-700 dark:text-red-400">{formatPercent(p.progress)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
