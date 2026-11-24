"use client";

/**
 * Upload documents: presigned POST straight to storage, then confirm.
 *
 * Per file: validate type/size against the server allowlist → getUploadUrl
 * (server creates the row and picks the key) → POST the returned fields plus
 * the file, with progress → confirmUpload (server verifies the bytes and queues
 * processing). A failed transfer removes the half-created document.
 */
import { useCallback, useId, useRef, useState, type DragEvent } from "react";
import { CheckCircle2, FileUp, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { ALLOWED_TYPES, allowedTypeForFilename } from "@/lib/file-types";
import { trpc } from "@/lib/trpc/client";
import { cn, formatBytes } from "@/lib/utils";
import { DOCUMENT_TYPES, defaultTypeFor, type DocumentTypeValue } from "./document-types";

type ItemStatus = "ready" | "invalid" | "uploading" | "confirming" | "done" | "error";

interface UploadItem {
  localId: number;
  file: File;
  type: DocumentTypeValue;
  status: ItemStatus;
  progress: number;
  error?: string;
}

const ACCEPT = ALLOWED_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)).join(",");
const CONCURRENCY = 2;

function validate(file: File): string | null {
  const allowed = allowedTypeForFilename(file.name);
  if (!allowed) return "This file type isn't supported";
  if (file.size === 0) return "This file is empty";
  if (file.size > allowed.maxBytes) return `Too large (the limit for this type is ${formatBytes(allowed.maxBytes, 0)})`;
  return null;
}

/** POST a file to a presigned form endpoint, reporting progress (0-100). */
function postForm(url: string, fields: Record<string, string>, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", file); // must be the last field for S3
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const message = /<Message>([^<]+)<\/Message>/.exec(xhr.responseText ?? "")?.[1];
      reject(new Error(message ? `Upload rejected: ${message}` : `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(form);
  });
}

export function UploadPanel({ projectId, onUploaded }: { projectId: string; onUploaded?: () => void }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const utils = trpc.useUtils();

  const getUploadUrl = trpc.document.getUploadUrl.useMutation({ meta: { silent: true } });
  const confirmUpload = trpc.document.confirmUpload.useMutation({ meta: { silent: true } });
  const cleanup = trpc.document.delete.useMutation({ meta: { silent: true } });

  const patch = (localId: number, p: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.localId === localId ? { ...i, ...p } : i)));

  const addFiles = useCallback((files: FileList | File[]) => {
    const added = Array.from(files).map<UploadItem>((file) => {
      const error = validate(file);
      return { localId: nextId.current++, file, type: defaultTypeFor(file.name), status: error ? "invalid" : "ready", progress: 0, error: error ?? undefined };
    });
    setItems((list) => [...list.filter((i) => i.status !== "done"), ...added]);
  }, []);

  const uploadOne = async (item: UploadItem): Promise<boolean> => {
    patch(item.localId, { status: "uploading", progress: 0, error: undefined });
    let documentId: string | null = null;
    try {
      const presign = await getUploadUrl.mutateAsync({ projectId, filename: item.file.name, size: item.file.size });
      documentId = presign.documentId;
      await postForm(presign.url, presign.fields, item.file, (pct) => patch(item.localId, { progress: pct }));
      patch(item.localId, { status: "confirming", progress: 100 });
      await confirmUpload.mutateAsync({ projectId, documentId, type: item.type });
      patch(item.localId, { status: "done" });
      return true;
    } catch (err) {
      if (documentId) cleanup.mutate({ projectId, id: documentId });
      patch(item.localId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
      return false;
    }
  };

  const start = async () => {
    const queue = items.filter((i) => i.status === "ready" || i.status === "error");
    if (queue.length === 0) return;
    setRunning(true);
    let ok = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (next < queue.length) {
          const item = queue[next++];
          if (await uploadOne(item)) ok++;
        }
      })
    );
    setRunning(false);
    await Promise.all([utils.document.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
    if (ok > 0) {
      toast.success(ok === 1 ? "File uploaded. Processing has started." : `${ok} files uploaded. Processing has started.`);
      onUploaded?.();
    }
    if (ok < queue.length) toast.error(`${queue.length - ok} file${queue.length - ok === 1 ? "" : "s"} could not be uploaded`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const pendingCount = items.filter((i) => i.status === "ready" || i.status === "error").length;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20" : "border-gray-300 dark:border-gray-700"
        )}
      >
        <UploadCloud className="mb-3 h-10 w-10 text-muted-foreground" aria-hidden />
        <p className="font-medium">Drag files here, or</p>
        <Button variant="outline" className="mt-3" onClick={() => inputRef.current?.click()} disabled={running}>
          <FileUp className="mr-2 h-4 w-4" aria-hidden />
          Choose files
        </Button>
        <label htmlFor={inputId} className="sr-only">
          Choose files to upload
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="mt-3 max-w-md text-xs text-muted-foreground">
          PDF, text, Markdown, CSV, JSON, subtitles (VTT/SRT), audio (MP3, WAV, M4A, OGG) and video (MP4, MOV, WebM). Recordings are transcribed with speaker
          labels.
        </p>
      </div>

      {items.length > 0 && (
        <ul className="divide-y rounded-lg border" aria-label="Files to upload">
          {items.map((item) => (
            <li key={item.localId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.file.name}>
                  {item.file.name}
                </p>
                <p className="text-xs text-muted-foreground">{formatBytes(item.file.size, 1)}</p>
                {(item.status === "uploading" || item.status === "confirming") && (
                  <Progress value={item.progress} className="mt-2 h-1.5" aria-label={`Uploading ${item.file.name}`} />
                )}
                {item.error && (
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {item.error}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(item.status === "ready" || item.status === "error") && (
                  <select
                    aria-label={`Document type for ${item.file.name}`}
                    value={item.type}
                    onChange={(e) => patch(item.localId, { type: e.target.value as DocumentTypeValue })}
                    disabled={running}
                    className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
                  >
                    {DOCUMENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
                {item.status === "uploading" && <span className="text-xs text-muted-foreground">{item.progress}%</span>}
                {item.status === "confirming" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Verifying
                  </span>
                )}
                {item.status === "done" && (
                  <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Uploaded
                  </span>
                )}
                {(item.status === "ready" || item.status === "invalid" || item.status === "error" || item.status === "done") && !running && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => setItems((list) => list.filter((i) => i.localId !== item.localId))}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingCount > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => void start()} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Uploading…
              </>
            ) : (
              `Upload ${pendingCount} file${pendingCount === 1 ? "" : "s"}`
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
