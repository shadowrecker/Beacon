"use client";

import type { NotificationType } from "@prisma/client";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";

type Prefs = RouterOutputs["user"]["me"]["notificationPrefs"];

export const NOTIFICATION_TYPE_INFO: Record<NotificationType, { label: string; description: string }> = {
  COMMENT_MENTION: { label: "Mentions", description: "Someone @mentions you in a comment." },
  COMMENT_REPLY: { label: "Replies", description: "Someone replies to a comment you wrote." },
  SYNTHESIS_COMPLETE: { label: "Synthesis finished", description: "A synthesis you started is ready." },
  RECOMMENDATION_GENERATED: { label: "New recommendations", description: "Recommendations you requested are ready." },
  INTEGRATION_SYNC: { label: "Integration problems", description: "A connected integration fails to sync (owners and admins)." },
  COMPETITOR_ALERT: { label: "Competitor alerts", description: "Important changes from competitors you track." },
  SENTIMENT_ALERT: { label: "Sentiment alerts", description: "Significant shifts in customer sentiment or churn risk." },
  OUTCOME_UPDATE: { label: "Outcome updates", description: "Progress on shipped recommendations you follow." },
  ORG_INVITE: { label: "Invitations", description: "You're invited to an organization." },
  WORKFLOW: { label: "Workflows", description: "Messages sent to you by automated workflows." },
  SYSTEM: { label: "Team updates", description: "Members joining your organizations and other account notices." },
};

const ORDER = Object.keys(NOTIFICATION_TYPE_INFO) as NotificationType[];

export function NotificationPreferences({ prefs }: { prefs: Prefs }) {
  const utils = trpc.useUtils();
  const update = trpc.user.update.useMutation({
    onMutate: async (vars) => {
      await utils.user.me.cancel();
      const previous = utils.user.me.getData();
      if (previous && vars.notificationPrefs) {
        utils.user.me.setData(undefined, {
          ...previous,
          notificationPrefs: { ...previous.notificationPrefs, ...vars.notificationPrefs } as Prefs,
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) utils.user.me.setData(undefined, context.previous);
    },
    onSuccess: () => toast.success("Notification preferences saved"),
    onSettled: () => void utils.user.me.invalidate(),
  });

  return (
    <Card id="notifications">
      <CardHeader>
        <CardTitle className="text-lg">Email notifications</CardTitle>
        <CardDescription>
          You always get these in Beacon&apos;s notification center. Choose which ones are also emailed to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {ORDER.map((type) => {
            const info = NOTIFICATION_TYPE_INFO[type];
            const id = `pref-${type}`;
            return (
              <li key={type} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <Label htmlFor={id} className="font-medium">
                    {info.label}
                  </Label>
                  <p id={`${id}-desc`} className="text-sm text-muted-foreground">
                    {info.description}
                  </p>
                </div>
                <Switch
                  id={id}
                  aria-describedby={`${id}-desc`}
                  checked={prefs[type]?.email ?? false}
                  disabled={update.isPending}
                  onCheckedChange={(email) => update.mutate({ notificationPrefs: { [type]: { email } } })}
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
