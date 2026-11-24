"use client";

import Link from "next/link";
import { ArrowLeft, BadgeCheck, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { categoryLabel } from "./category-filter";
import { InstallFlow } from "./install-flow";
import { RatingStars } from "./rating-stars";
import { ReviewForm } from "./review-form";
import { ReviewList } from "./review-list";
import { SafeMarkdown } from "./safe-markdown";

export function ConnectorDetail({ slug }: { slug: string }) {
  const detail = trpc.marketplace.get.useQuery({ slug });

  if (detail.isLoading) return <LoadingState rows={4} label="Loading connector" />;
  if (detail.isError || !detail.data) {
    return <ErrorState message={detail.error?.message ?? "Connector not found"} onRetry={() => void detail.refetch()} />;
  }
  const c = detail.data;

  return (
    <div className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/marketplace">
          <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
          Marketplace
        </Link>
      </Button>

      <header className="flex flex-col gap-4 border-b pb-6 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            {c.name}
            {c.isVerified && <BadgeCheck className="h-6 w-6 text-primary" aria-label="Verified" />}
          </h1>
          <p className="max-w-2xl text-muted-foreground">{c.description}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{categoryLabel(c.category)}</Badge>
            {c.isOfficial && <Badge variant="outline">Official</Badge>}
            <Badge variant="outline">{c.auth === "oauth" ? "OAuth" : "API token"}</Badge>
            <RatingStars value={c.ratingAverage} count={c.ratingCount} />
            <span className="text-muted-foreground">{c.installCount.toLocaleString()} installs</span>
          </div>
          <p className="text-xs text-muted-foreground">
            By{" "}
            {c.publisherUrl ? (
              <a href={c.publisherUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                {c.publisherName}
                <ExternalLink className="h-3 w-3" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : (
              c.publisherName
            )}{" "}
            · version {c.version}
          </p>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr,360px]">
        <div className="space-y-8">
          <section aria-labelledby="about-heading" className="space-y-3">
            <h2 id="about-heading" className="text-lg font-semibold">
              About
            </h2>
            {c.longDescription && <p className="text-sm leading-relaxed">{c.longDescription}</p>}
            {c.capabilities.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Capabilities">
                {c.capabilities.map((cap) => (
                  <li key={cap}>
                    <Badge variant="outline">{cap}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {c.setupGuide && (
            <section aria-labelledby="setup-heading" className="space-y-3">
              <h2 id="setup-heading" className="text-lg font-semibold">
                Setup guide
              </h2>
              <SafeMarkdown source={c.setupGuide} className="rounded-lg border p-4" />
            </section>
          )}
          <ReviewList slug={c.slug} canVote={c.canReview} />
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{c.install ? "Installed" : "Install"}</CardTitle>
            </CardHeader>
            <CardContent>
              <InstallFlow connector={c} />
            </CardContent>
          </Card>
          {c.canReview ? (
            <ReviewForm key={c.myReview?.id ?? "new"} slug={c.slug} myReview={c.myReview} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {c.install ? "Viewers can't write reviews." : "Install this connector to review it."}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
