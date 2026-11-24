import { PageHeader } from "@/components/layout/page-header";
import { DeveloperNav } from "@/components/developer/developer-nav";
import { DeveloperOverview } from "@/components/developer/developer-overview";

export default function DeveloperPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Developer" description="Build on Beacon with the REST API, the SDK and webhooks." />
      <DeveloperNav />
      <DeveloperOverview />
    </div>
  );
}
