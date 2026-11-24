"use client";

import { use } from "react";
import { DecisionForm } from "@/components/outcomes/decision-form";
import { DecisionLog } from "@/components/outcomes/decision-log";

export default function DecisionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Decision log</h2>
        <p className="text-sm text-muted-foreground">Product decisions, the reasoning behind them and what happened afterwards.</p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div>
          <DecisionForm projectId={projectId} />
        </div>
        <section aria-label="Recorded decisions">
          <DecisionLog projectId={projectId} />
        </section>
      </div>
    </div>
  );
}
