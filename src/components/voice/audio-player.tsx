"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Plays a recording from a short-lived presigned URL. The audio is fetched on
 * demand into a blob: URL, which keeps playback within the CSP (media-src allows
 * 'self' and blob:; the storage origin is only in connect-src) and avoids
 * downloading large files until the user asks.
 */
export function AudioPlayer({ getUrl }: { getUrl: () => Promise<string | null> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!src) return;
    return () => URL.revokeObjectURL(src);
  }, [src]);

  const load = async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const url = await getUrl();
      if (!url) throw new Error("unavailable");
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setSrc(URL.createObjectURL(await res.blob()));
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") setError("The audio couldn't be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  };

  if (src) {
    return (
      <audio controls autoPlay src={src} className="w-full">
        <track kind="captions" />
      </audio>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
        {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Play className="mr-1.5 h-4 w-4" aria-hidden />}
        {loading ? "Loading audio…" : "Play recording"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
