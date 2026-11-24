"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Link2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DocumentList } from "@/components/documents/document-list";
import { UploadPanel } from "@/components/documents/upload-panel";
import { UrlImportDialog } from "@/components/documents/url-import-dialog";
import { trpc } from "@/lib/trpc/client";

export default function DocumentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const canWrite = project.data?.permissions.write ?? false;

  const actions = canWrite ? (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setUploadOpen(true)}>
        <Upload className="mr-2 h-4 w-4" aria-hidden /> Upload files
      </Button>
      <Button variant="outline" onClick={() => setImportOpen(true)}>
        <Link2 className="mr-2 h-4 w-4" aria-hidden /> Import URL
      </Button>
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Documents</h2>
          <p className="text-sm text-muted-foreground">Customer research this project&apos;s answers, themes and recommendations are built from.</p>
        </div>
        {actions}
      </div>

      <DocumentList projectId={projectId} canWrite={canWrite} emptyAction={actions} />

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload files</DialogTitle>
            <DialogDescription>Files are stored privately in this project and processed in the background.</DialogDescription>
          </DialogHeader>
          <UploadPanel projectId={projectId} />
        </DialogContent>
      </Dialog>
      <UrlImportDialog projectId={projectId} open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
