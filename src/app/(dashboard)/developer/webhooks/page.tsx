import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DeveloperNav } from "@/components/developer/developer-nav";
import { WebhookList } from "@/components/developer/webhook-list";

const VERIFY_SNIPPET = `import { verifyWebhookSignature } from "@beacon-intelligence/sdk";

// Use the raw request body, exactly as received.
const ok = await verifyWebhookSignature({
  payload: rawBody,
  signature: req.headers["x-beacon-signature"],
  timestamp: req.headers["x-beacon-timestamp"],
  secret: process.env.BEACON_WEBHOOK_SECRET,
});
if (!ok) return res.status(400).end();`;

export default function WebhooksPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Webhooks" description="Receive signed events from this workspace at your own endpoints." />
      <DeveloperNav />
      <WebhookList />
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Verifying deliveries</CardTitle>
          <CardDescription>
            Each delivery is a POST with headers x-beacon-event, x-beacon-delivery, x-beacon-timestamp and x-beacon-signature, where the
            signature is sha256= followed by the hex HMAC-SHA256 of &quot;timestamp.body&quot; keyed with your signing secret. Reject
            deliveries older than five minutes. Respond with any 2xx status within 10 seconds; anything else is retried up to 6 times
            with exponential backoff, and a webhook is disabled after 20 consecutive failed deliveries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            <code>{VERIFY_SNIPPET}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
