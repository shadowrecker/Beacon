"use client";

import { useParams } from "next/navigation";
import { ConnectorDetail } from "@/components/marketplace/connector-detail";

export default function ConnectorPage() {
  const { slug } = useParams<{ slug: string }>();
  return <ConnectorDetail slug={slug} />;
}
