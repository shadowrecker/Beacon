import { PageHeader } from "@/components/layout/page-header";
import { DeveloperNav } from "@/components/developer/developer-nav";
import { ApiKeyList } from "@/components/developer/api-key-list";
import { ApiUsage } from "@/components/developer/api-usage";

export default function ApiKeysPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="API keys" description="Keys authenticate REST API and SDK requests for this workspace." />
      <DeveloperNav />
      <ApiKeyList />
      <ApiUsage />
    </div>
  );
}
