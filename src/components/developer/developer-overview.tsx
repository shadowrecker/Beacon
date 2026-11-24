"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, KeyRound, Webhook } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function Count({ loading, error, value, label }: { loading: boolean; error: boolean; value: number; label: string }) {
  if (loading) return <Skeleton className="h-6 w-24" />;
  if (error) return <p className="text-sm text-red-600">Couldn&apos;t load</p>;
  return (
    <p className="text-sm text-gray-600 dark:text-gray-400">
      <span className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{value}</span> {label}
    </p>
  );
}

export function DeveloperOverview() {
  const keys = trpc.apiKey.list.useQuery({ limit: 100 });
  const hooks = trpc.webhook.list.useQuery({ limit: 100 });
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const disabledHooks = hooks.data?.items.filter((h) => !h.active).length ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <KeyRound className="h-6 w-6 text-blue-600" aria-hidden />
            <CardTitle className="text-lg">
              <Link href="/developer/keys" className="hover:underline">
                API keys
              </Link>
            </CardTitle>
            <CardDescription>Scoped keys for the REST API and SDK.</CardDescription>
          </CardHeader>
          <CardContent>
            <Count loading={keys.isLoading} error={keys.isError} value={keys.data?.items.length ?? 0} label="active keys" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Webhook className="h-6 w-6 text-green-600" aria-hidden />
            <CardTitle className="text-lg">
              <Link href="/developer/webhooks" className="hover:underline">
                Webhooks
              </Link>
            </CardTitle>
            <CardDescription>Signed event deliveries to your endpoints.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <Count loading={hooks.isLoading} error={hooks.isError} value={hooks.data?.items.length ?? 0} label="webhooks" />
            {disabledHooks > 0 && <p className="text-xs text-red-600">{disabledHooks} disabled or paused</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <BookOpen className="h-6 w-6 text-purple-600" aria-hidden />
            <CardTitle className="text-lg">
              <Link href="/developer/docs" className="hover:underline">
                API reference
              </Link>
            </CardTitle>
            <CardDescription>Every endpoint, its scope, parameters and responses.</CardDescription>
          </CardHeader>
          <CardContent>
            <a href="/api/v1/openapi.json" className="text-sm text-blue-600 underline dark:text-blue-400">
              Download the OpenAPI document
            </a>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quick start</CardTitle>
          <CardDescription>Create a key with the projects:read scope, then list your projects.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            <code>{`curl -H "Authorization: Bearer $BEACON_API_KEY" ${origin || ""}/api/v1/projects`}</code>
          </pre>
          <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            <code>{`import { BeaconClient } from "@beacon-intelligence/sdk";

const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY!, baseUrl: "${origin || ""}/api/v1" });
const { data: projects } = await beacon.listProjects();`}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
