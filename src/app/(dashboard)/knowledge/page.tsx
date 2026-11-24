"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink, Network } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { useActiveOrgId } from "@/lib/active-org";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EntityNeighborhood } from "@/components/knowledge/entity-neighborhood";
import { KnowledgeSearch } from "@/components/knowledge/knowledge-search";
import { KnowledgeStats, TopHubs } from "@/components/knowledge/knowledge-stats";
import { MergeSuggestions } from "@/components/knowledge/merge-suggestions";
import { PathFinder } from "@/components/knowledge/path-finder";
import { QueryInterface } from "@/components/knowledge/query-interface";
import { EntityTypeBadge } from "@/components/knowledge/entity-card";

function Explorer() {
  const [selected, setSelected] = useState<string | null>(null);
  const hubs = trpc.knowledge.getTopHubs.useQuery({ limit: 10 });
  const focusId = selected ?? hubs.data?.[0]?.id ?? null;
  const focus = trpc.knowledge.getEntity.useQuery({ entityId: focusId ?? "" }, { enabled: !!focusId });

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        <KnowledgeSearch selectedId={focusId} onSelect={setSelected} />
      </div>
      <div className="space-y-6 lg:col-span-2">
        {!focusId ? (
          hubs.isLoading ? (
            <LoadingState rows={2} label="Loading graph" />
          ) : (
            <EmptyState
              icon={<Network className="h-8 w-8" />}
              title="Your knowledge graph is empty"
              description="When documents finish processing, Beacon extracts the customers, features, pain points and competitors they mention and links them here."
            />
          )
        ) : (
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <div className="flex min-w-0 items-center gap-2">
                <CardTitle className="truncate text-lg">{focus.data?.name ?? "Entity"}</CardTitle>
                {focus.data && <EntityTypeBadge type={focus.data.type} />}
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/knowledge/${focusId}`}>
                  Details
                  <ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              {focus.data?.description && <p className="mb-3 text-sm text-muted-foreground">{focus.data.description}</p>}
              <EntityNeighborhood entityId={focusId} onSelect={setSelected} />
            </CardContent>
          </Card>
        )}
        <TopHubs selectedId={focusId} onSelect={setSelected} />
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  // Remount on org switch so selections never point into another workspace.
  const orgId = useActiveOrgId();
  const stats = trpc.knowledge.getStats.useQuery();
  const pending = stats.data?.pendingMergeSuggestions ?? 0;

  return (
    <div key={orgId ?? "personal"} className="space-y-6">
      <PageHeader title="Knowledge graph" description="Customers, features, pain points and competitors extracted from your feedback, and how they connect." />
      <KnowledgeStats />
      <Tabs defaultValue="explore" className="space-y-4">
        <TabsList>
          <TabsTrigger value="explore">Explore</TabsTrigger>
          <TabsTrigger value="ask">Ask</TabsTrigger>
          <TabsTrigger value="paths">Connections</TabsTrigger>
          <TabsTrigger value="merge">Merge review{pending > 0 ? ` (${pending})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="explore">
          <Explorer />
        </TabsContent>
        <TabsContent value="ask">
          <QueryInterface />
        </TabsContent>
        <TabsContent value="paths">
          <PathFinder />
        </TabsContent>
        <TabsContent value="merge">
          <MergeSuggestions />
        </TabsContent>
      </Tabs>
    </div>
  );
}
