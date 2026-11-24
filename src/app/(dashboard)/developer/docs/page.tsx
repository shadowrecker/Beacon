import { PageHeader } from "@/components/layout/page-header";
import { DeveloperNav } from "@/components/developer/developer-nav";
import { ApiDocs } from "@/components/developer/api-docs";
import { buildOpenApiDocument } from "@/server/api/openapi";

export const dynamic = "force-dynamic";

/** Rendered server-side from the same route definitions that serve the API, so it always matches. */
export default function ApiReferencePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="API reference" description="Generated from the live API definition." />
      <DeveloperNav />
      <ApiDocs doc={buildOpenApiDocument()} />
    </div>
  );
}
