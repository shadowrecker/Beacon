import { PageHeader } from "@/components/layout/page-header";
import { WorkflowBuilder } from "@/components/workflows/workflow-builder";

export default async function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ template?: string | string[] }> }) {
  const { template } = await searchParams;
  const templateId = typeof template === "string" && /^[a-z0-9-]{1,100}$/.test(template) ? template : undefined;
  return (
    <div className="space-y-6">
      <PageHeader title="New workflow" description="Choose a trigger, add conditions, then the actions to run." />
      <WorkflowBuilder mode="create" templateId={templateId} />
    </div>
  );
}
