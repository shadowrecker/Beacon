"use client";

import { use } from "react";
import { ImportAnalyticsDialog } from "@/components/analytics/import-analytics-dialog";
import { ImportsList } from "@/components/analytics/imports-list";
import { UsageOverlay } from "@/components/analytics/usage-overlay";
import { CorrelationsPanel } from "@/components/analytics/correlations-panel";

export default function AnalyticsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Usage analytics</h2>
          <p className="text-sm text-muted-foreground">
            Import product usage data and see how it moves with what customers are telling you.
          </p>
        </div>
        <ImportAnalyticsDialog projectId={projectId} />
      </div>
      <CorrelationsPanel projectId={projectId} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <UsageOverlay projectId={projectId} />
        </div>
        <ImportsList projectId={projectId} />
      </div>
    </div>
  );
}
