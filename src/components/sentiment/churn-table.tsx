"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { riskBadgeVariant, riskLabel } from "./format";
import { PredictionCard } from "./prediction-card";

/** Accounts ranked by AI-assessed churn risk (clearly labeled as an AI risk assessment). */
export function ChurnTable({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = trpc.sentiment.getChurnPredictions.useInfiniteQuery({ projectId, limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Churn risk · AI risk assessment</CardTitle>
        <p className="text-xs text-muted-foreground">
          Per-account judgements from the latest weekly, monthly or manual analysis, based on listed signals. Not a statistical prediction.
        </p>
      </CardHeader>
      <CardContent>
        {list.isLoading ? (
          <LoadingState rows={3} label="Loading risk assessments" />
        ) : list.isError ? (
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ShieldAlert className="h-8 w-8" />}
            title="No account assessments yet"
            description="Accounts are assessed when feedback identifies the customer (document metadata from integrations, or the account named in the text)."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="w-8 pb-2">
                    <span className="sr-only">Details</span>
                  </th>
                  <th scope="col" className="pb-2 font-medium">Account</th>
                  <th scope="col" className="pb-2 font-medium">Segment</th>
                  <th scope="col" className="pb-2 font-medium">AI risk score</th>
                  <th scope="col" className="pb-2 font-medium">Risk</th>
                  <th scope="col" className="pb-2 font-medium">Top signal</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((p) => {
                  const expanded = open === p.id;
                  const top = p.signals.find((s) => s.source === "ai") ?? p.signals[p.signals.length - 1];
                  return (
                    <Fragment key={p.id}>
                      <tr>
                        <td className="py-2">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-expanded={expanded}
                            aria-controls={`assessment-${p.id}`}
                            aria-label={`${expanded ? "Hide" : "Show"} assessment for ${p.customerName ?? "account"}`}
                            onClick={() => setOpen(expanded ? null : p.id)}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                          </Button>
                        </td>
                        <th scope="row" className="py-2 text-left font-medium">{p.customerName ?? "Unnamed account"}</th>
                        <td className="py-2 capitalize text-muted-foreground">{p.segment ?? "—"}</td>
                        <td className="py-2 tabular-nums">{Math.round(p.churnProbability * 100)}</td>
                        <td className="py-2">
                          <Badge variant={riskBadgeVariant(p.riskLevel)}>{riskLabel(p.riskLevel)}</Badge>
                        </td>
                        <td className="max-w-xs truncate py-2 text-muted-foreground">{top?.label ?? "—"}</td>
                      </tr>
                      {expanded && (
                        <tr id={`assessment-${p.id}`}>
                          <td />
                          <td colSpan={5} className="pb-4">
                            <PredictionCard assessment={p} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.hasNextPage && (
          <Button variant="outline" className="mt-3 w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
