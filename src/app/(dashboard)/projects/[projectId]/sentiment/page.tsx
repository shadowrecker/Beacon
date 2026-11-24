"use client";

import { useParams } from "next/navigation";
import { SentimentDashboard } from "@/components/sentiment/sentiment-dashboard";

export default function SentimentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Sentiment and churn risk</h2>
        <p className="text-sm text-muted-foreground">How customers feel over time, what changed, and which accounts look at risk.</p>
      </div>
      <SentimentDashboard projectId={projectId} />
    </div>
  );
}
