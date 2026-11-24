"use client";

import Link from "next/link";
import { BadgeCheck, Download } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { categoryLabel } from "./category-filter";
import { RatingStars } from "./rating-stars";

export type ConnectorSummary = RouterOutputs["marketplace"]["browse"]["items"][number];

export function ConnectorCard({ connector }: { connector: ConnectorSummary }) {
  return (
    <Link
      href={`/marketplace/${connector.slug}`}
      className="block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${connector.name}${connector.installed ? " (installed)" : ""}`}
    >
      <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
        <CardHeader className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5 text-base">
              {connector.name}
              {connector.isVerified && <BadgeCheck className="h-4 w-4 text-primary" aria-label="Verified" />}
            </CardTitle>
            {connector.installed && <Badge variant="positive">Installed</Badge>}
          </div>
          <CardDescription className="line-clamp-2">{connector.description}</CardDescription>
        </CardHeader>
        <CardContent className="mt-auto space-y-3">
          <div className="flex flex-wrap gap-1">
            <Badge variant="secondary">{categoryLabel(connector.category)}</Badge>
            {connector.isOfficial && <Badge variant="outline">Official</Badge>}
            <Badge variant="outline">{connector.pricing === "FREE" ? "Free" : connector.pricing === "PAID" ? "Paid" : "Enterprise"}</Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <RatingStars value={connector.ratingAverage} count={connector.ratingCount} />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Download className="h-3.5 w-3.5" aria-hidden />
              {connector.installCount.toLocaleString()} <span className="sr-only">installs</span>
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
