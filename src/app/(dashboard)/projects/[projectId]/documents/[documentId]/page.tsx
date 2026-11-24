"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { DocumentDetail } from "@/components/documents/document-detail";
import { LoadingState } from "@/components/ui/states";

function Detail() {
  const { projectId, documentId } = useParams<{ projectId: string; documentId: string }>();
  const search = useSearchParams();
  const raw = search?.get("chunk") ?? null;
  // ?chunk=<position> opens the document at a cited passage.
  const focus = raw !== null && /^\d{1,7}$/.test(raw) ? Number(raw) : null;
  return <DocumentDetail key={`${documentId}:${focus ?? ""}`} projectId={projectId} documentId={documentId} focusPosition={focus} />;
}

export default function DocumentDetailPage() {
  return (
    <Suspense fallback={<LoadingState rows={4} label="Loading document" />}>
      <Detail />
    </Suspense>
  );
}
