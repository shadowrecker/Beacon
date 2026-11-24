"use client";

/**
 * Ask questions about a project's research. History is shown oldest → newest;
 * "Load earlier questions" pages backwards. Answers cite verified passages.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Loader2, MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc/client";
import { CitationList, type CitationView } from "./citation-list";
import { Markdown } from "./markdown";

const MAX_QUESTION = 2000;
const PAGE = 20;

interface Exchange {
  id: string;
  question: string;
  answer: string | null;
  citations: CitationView[];
  insufficientEvidence: boolean;
  createdAt: Date | string;
}

function QuestionBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-sm text-white">{text}</p>
    </div>
  );
}

function AnswerBubble({ projectId, exchange }: { projectId: string; exchange: Exchange }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm border bg-gray-50 px-4 py-3 dark:bg-gray-900">
        {exchange.insufficientEvidence && (
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-yellow-800 dark:text-yellow-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Limited evidence in this project&apos;s documents
          </p>
        )}
        <Markdown text={exchange.answer ?? "No answer was recorded."} />
        <CitationList projectId={projectId} citations={exchange.citations} />
        <p className="mt-2 text-xs text-muted-foreground">
          <time dateTime={new Date(exchange.createdAt).toISOString()}>{formatDistanceToNow(new Date(exchange.createdAt), { addSuffix: true })}</time>
        </p>
      </div>
    </div>
  );
}

export function ChatInterface({ projectId, canAsk }: { projectId: string; canAsk: boolean }) {
  const inputId = useId();
  const hintId = useId();
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const history = trpc.query.history.useInfiniteQuery({ projectId, limit: PAGE }, { getNextPageParam: (last) => last.nextCursor });
  const exchanges = useMemo<Exchange[]>(() => [...(history.data?.pages ?? [])].reverse().flatMap((p) => p.items), [history.data]);

  const ask = trpc.query.ask.useMutation({
    onSuccess: async () => {
      await utils.query.history.invalidate({ projectId });
      setPending(null);
    },
    onError: (_err, vars) => {
      setPending(null);
      setQuestion(vars.question);
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [exchanges.length, pending]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = question.trim();
    if (q.length < 3 || ask.isPending) return;
    setPending(q);
    setQuestion("");
    ask.mutate({ projectId, question: q });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex min-h-[60vh] flex-col rounded-lg border">
      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" aria-busy={ask.isPending}>
        {history.isLoading ? (
          <LoadingState rows={3} label="Loading conversation" />
        ) : history.isError ? (
          <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />
        ) : (
          <>
            {history.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
                  {history.isFetchingNextPage ? "Loading…" : "Load earlier questions"}
                </Button>
              </div>
            )}
            {exchanges.length === 0 && !pending && (
              <EmptyState
                icon={<MessageSquare className="h-8 w-8" />}
                title="Ask about your research"
                description="For example: “What frustrates customers most about onboarding?” Answers only use this project's documents and cite the passages they rely on."
              />
            )}
            {exchanges.map((x) => (
              <div key={x.id} className="space-y-2">
                <QuestionBubble text={x.question} />
                <AnswerBubble projectId={projectId} exchange={x} />
              </div>
            ))}
            {pending && (
              <div className="space-y-2">
                <QuestionBubble text={pending} />
                <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching your documents and writing an answer…
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="border-t p-3">
        <Label htmlFor={inputId} className="sr-only">
          Your question
        </Label>
        <div className="flex items-end gap-2">
          <Textarea
            id={inputId}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={MAX_QUESTION}
            rows={2}
            disabled={!canAsk || ask.isPending}
            placeholder={canAsk ? "Ask a question about this project's documents" : "Viewers can read answers but can't ask new questions"}
            aria-describedby={hintId}
            className="resize-none"
          />
          <Button type="submit" size="icon" disabled={!canAsk || ask.isPending || question.trim().length < 3} aria-label="Send question">
            {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
        <p id={hintId} className="mt-1 text-xs text-muted-foreground">
          Enter to send, Shift+Enter for a new line. {question.length > MAX_QUESTION - 200 ? `${MAX_QUESTION - question.length} characters left.` : ""}
        </p>
      </form>
    </div>
  );
}
