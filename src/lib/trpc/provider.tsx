"use client";

import { useState, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";
import { getActiveOrgId } from "@/lib/active-org";
import { toast } from "@/components/ui/toast";

function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof TRPCClientError) {
    return (error.data as { httpStatus?: number } | undefined)?.httpStatus;
  }
  return undefined;
}

/** Retry only server/network failures, never 4xx (which won't change on retry). */
function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined && status < 500) return false;
  return failureCount < 2;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (httpStatusOf(error) === 401) window.location.assign("/sign-in");
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        // Mutations that render their own error UI set meta.silent.
        if (mutation.meta?.silent) return;
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export function TRPCProvider({ children }: { children: ReactNode }) {
  // Created once per browser session (never shared across server requests).
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
          headers() {
            const orgId = getActiveOrgId();
            return orgId ? { "x-org-id": orgId } : {};
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
