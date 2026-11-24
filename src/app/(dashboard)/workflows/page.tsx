"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkflowList } from "@/components/workflows/workflow-list";
import { TemplateGallery } from "@/components/workflows/template-gallery";

export default function WorkflowsPage() {
  // Same query (and cache entry) as <WorkflowList>; read here for the role-aware header.
  const list = trpc.workflow.list.useInfiniteQuery({ limit: 25 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const canManage = list.data?.pages[0]?.canManage ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workflows"
        description="Automate what happens when feedback, syntheses and recommendations change."
        actions={
          canManage ? (
            <Button asChild>
              <Link href="/workflows/new">
                <Plus className="mr-2 h-4 w-4" aria-hidden /> New workflow
              </Link>
            </Button>
          ) : undefined
        }
      />
      <Tabs defaultValue="workflows">
        <TabsList>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
        </TabsList>
        <TabsContent value="workflows" className="mt-4">
          <WorkflowList />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplateGallery canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
