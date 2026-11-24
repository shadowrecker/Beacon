"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function DataExport() {
  const exportData = trpc.user.exportData.useMutation();
  const [truncated, setTruncated] = useState<string[]>([]);

  const run = async () => {
    let data;
    try {
      data = await exportData.mutateAsync();
    } catch {
      return; // surfaced by the global error toast
    }
    const date = new Date().toISOString().slice(0, 10);
    download(`beacon-export-${date}.json`, JSON.stringify(data, null, 2));
    setTruncated(data.truncated);
    toast.success("Your data export has downloaded");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Your data</CardTitle>
        <CardDescription>
          Download a JSON copy of your profile, memberships, comments, notifications, questions you asked and decisions you logged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" onClick={() => void run()} disabled={exportData.isPending}>
          {exportData.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Download className="mr-2 h-4 w-4" aria-hidden />
          )}
          Export my data
        </Button>
        {truncated.length > 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Your export reached its size limit for: {truncated.join(", ")}. The most recent items are included; contact support for a
            complete copy.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Project content such as documents and analyses belongs to your organizations and isn&apos;t part of this export.
        </p>
      </CardContent>
    </Card>
  );
}
