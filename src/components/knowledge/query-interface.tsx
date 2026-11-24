"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquareText, Sparkles } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { EntityTypeBadge } from "./entity-card";

type Answer = RouterOutputs["knowledge"]["query"];

/** Ask a natural-language question about the knowledge graph; shows the cited entities. */
export function QueryInterface() {
  const utils = trpc.useUtils();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const ask = trpc.knowledge.query.useMutation({
    onSuccess: async (res) => {
      setAnswer(res);
      await utils.knowledge.getRecentQueries.invalidate();
    },
  });
  const recent = trpc.knowledge.getRecentQueries.useInfiniteQuery({ limit: 10 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const history = recent.data?.pages.flatMap((p) => p.items) ?? [];
  const trimmed = question.trim();

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed.length >= 3) ask.mutate({ question: trimmed });
          }}
        >
          <Label htmlFor="kg-question">Ask the knowledge graph</Label>
          <Textarea
            id="kg-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Which customers are affected by slow dashboards, and which competitors come up alongside them?"
            maxLength={1000}
            rows={3}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{question.length}/1000</span>
            <Button type="submit" disabled={trimmed.length < 3 || ask.isPending}>
              <Sparkles className="mr-2 h-4 w-4" aria-hidden />
              {ask.isPending ? "Thinking…" : "Ask"}
            </Button>
          </div>
        </form>

        {ask.isPending && <LoadingState rows={2} label="Generating answer" />}
        {answer && !ask.isPending && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Answer</CardTitle>
              <p className="text-xs text-muted-foreground">
                Based on {answer.retrievedCount} entities · confidence {Math.round(answer.confidence * 100)}%
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="whitespace-pre-line text-sm leading-relaxed">{answer.answer}</p>
              {answer.insights.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {answer.insights.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
              {answer.citedEntities.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cited entities</h4>
                  <ul className="flex flex-wrap gap-2">
                    {answer.citedEntities.map((e) => (
                      <li key={e.id}>
                        <Link href={`/knowledge/${e.id}`} className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-sm hover:bg-muted">
                          {e.name}
                          <EntityTypeBadge type={e.type} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <section aria-labelledby="kg-recent" className="space-y-3">
        <h3 id="kg-recent" className="text-sm font-semibold">
          Your recent questions
        </h3>
        {recent.isLoading ? (
          <LoadingState rows={3} label="Loading recent questions" />
        ) : recent.isError ? (
          <ErrorState message={recent.error.message} onRetry={() => void recent.refetch()} />
        ) : history.length === 0 ? (
          <EmptyState icon={<MessageSquareText className="h-8 w-8" />} title="No questions yet" />
        ) : (
          <ul className="space-y-2">
            {history.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  className="w-full rounded-lg border p-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  onClick={() => setQuestion(q.query)}
                >
                  <span className="line-clamp-2 font-medium">{q.query}</span>
                  {q.answerPreview && <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{q.answerPreview}</span>}
                  <span className="mt-1 block text-xs text-muted-foreground">{formatDistanceToNow(q.createdAt, { addSuffix: true })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {recent.hasNextPage && (
          <Button variant="outline" size="sm" className="w-full" onClick={() => void recent.fetchNextPage()} disabled={recent.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </section>
    </div>
  );
}
