"use client";

import { useParams } from "next/navigation";
import { ChatInterface } from "@/components/query/chat-interface";
import { trpc } from "@/lib/trpc/client";

export default function AskPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Ask</h2>
        <p className="text-sm text-muted-foreground">Questions are answered from this project&apos;s documents, with the passages they rely on.</p>
      </div>
      <ChatInterface projectId={projectId} canAsk={project.data?.permissions.runAI ?? false} />
    </div>
  );
}
