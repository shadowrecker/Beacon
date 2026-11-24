"use client";

import { use } from "react";
import { PresentationDetail } from "@/components/presentations/presentation-detail";

export default function PresentationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PresentationDetail id={id} />;
}
