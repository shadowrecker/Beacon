"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/states";
import { GeneratePresentationForm } from "@/components/presentations/generate-form";

function NewPresentationView() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project");
  const back = projectId ? `/presentations?project=${encodeURIComponent(projectId)}` : "/presentations";
  return (
    <div className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="gap-1">
        <Link href={back}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Presentations
        </Link>
      </Button>
      <PageHeader title="New presentation" description="Choose an audience and format; Beacon drafts the slides for you to edit." />
      <GeneratePresentationForm initialProjectId={projectId} />
    </div>
  );
}

export default function NewPresentationPage() {
  return (
    <Suspense fallback={<LoadingState rows={4} />}>
      <NewPresentationView />
    </Suspense>
  );
}
