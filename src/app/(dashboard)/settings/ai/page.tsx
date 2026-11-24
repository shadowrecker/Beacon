import { PageHeader } from "@/components/layout/page-header";
import { CustomAIForm } from "@/components/settings-ai/custom-ai-form";

export default function AISettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="AI settings" description="Tailor how Beacon's AI writes and categorizes for this workspace." />
      <CustomAIForm />
    </div>
  );
}
