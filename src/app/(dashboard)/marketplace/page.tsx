"use client";

import { PageHeader } from "@/components/layout/page-header";
import { FeaturedConnectors, InstalledConnectors, MarketplaceGrid } from "@/components/marketplace/marketplace-grid";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function MarketplacePage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Marketplace" description="Browse connectors, install them for your workspace and see what other teams think." />
      <Tabs defaultValue="browse" className="space-y-6">
        <TabsList>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="installed">Installed</TabsTrigger>
        </TabsList>
        <TabsContent value="browse" className="space-y-8">
          <FeaturedConnectors />
          <MarketplaceGrid />
        </TabsContent>
        <TabsContent value="installed">
          <InstalledConnectors />
        </TabsContent>
      </Tabs>
    </div>
  );
}
