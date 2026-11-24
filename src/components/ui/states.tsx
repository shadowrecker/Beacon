"use client";

/**
 * Shared loading / empty / error states so every data view handles all three
 * consistently. Use <QueryState query={...}> or the individual pieces.
 */
import type { ReactNode } from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

export function LoadingState({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="mb-3 text-muted-foreground" aria-hidden>
        {icon ?? <Inbox className="h-8 w-8" />}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center rounded-lg border border-destructive/30 px-6 py-10 text-center">
      <AlertTriangle className="mb-3 h-8 w-8 text-destructive" aria-hidden />
      <h3 className="text-base font-semibold">Couldn&apos;t load this</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{message ?? "Something went wrong. Please try again."}</p>
      {onRetry && (
        <Button variant="outline" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch: () => unknown;
}

/**
 * Render loading, error, empty, or the data. `isEmpty` decides emptiness
 * (defaults to an empty array check).
 */
export function QueryState<T>({
  query,
  empty,
  isEmpty,
  loadingRows,
  children,
}: {
  query: QueryLike<T>;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loadingRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <LoadingState rows={loadingRows} />;
  if (query.isError) return <ErrorState message={query.error?.message} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return <LoadingState rows={loadingRows} />;
  const emptyCheck = isEmpty ?? ((d: T) => Array.isArray(d) && d.length === 0);
  if (empty && emptyCheck(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
