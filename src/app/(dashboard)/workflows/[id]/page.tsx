import { WorkflowDetail } from "@/components/workflows/workflow-detail";

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowDetail id={id} />;
}
