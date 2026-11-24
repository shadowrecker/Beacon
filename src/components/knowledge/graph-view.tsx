"use client";

/**
 * Force-directed view of a knowledge-graph neighborhood. The canvas library is
 * browser-only, so it is loaded with next/dynamic (ssr: false). Tooltips are
 * HTML, so every label is escaped (entity names come from customer content).
 * A visually hidden list mirrors the graph for screen readers.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { colorFor, typeLabel } from "./constants";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export interface GraphNodeInput {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  depth?: number;
}

export interface GraphEdgeInput {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  strength: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

interface Props {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  centerId?: string;
  height?: number;
  label: string;
  onNodeClick?: (id: string) => void;
}

export function GraphView({ nodes, edges, centerId, height = 460, label, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        isCenter: n.id === centerId,
        val: Math.max(2, Math.log2(n.mentionCount + 1) * 3),
      })),
      links: edges.map((e) => ({ source: e.sourceId, target: e.targetId, type: e.type, strength: e.strength })),
    }),
    [nodes, edges, centerId]
  );

  const typesPresent = useMemo(() => [...new Set(nodes.map((n) => n.type))].sort(), [nodes]);
  const nameById = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes]);

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg border bg-background" style={{ height }} role="figure" aria-label={label}>
        {width > 0 && (
          <ForceGraph2D
            width={width}
            height={height}
            graphData={data}
            nodeRelSize={4}
            nodeLabel={(n) => `${escapeHtml(String(n.name))} (${escapeHtml(typeLabel(String(n.type)))})`}
            nodeColor={(n) => colorFor(String(n.type))}
            linkLabel={(l) => escapeHtml(typeLabel(String(l.type)))}
            linkWidth={(l) => 0.5 + Number(l.strength ?? 0) * 2}
            linkColor={() => "rgba(120,120,120,0.45)"}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            cooldownTicks={120}
            onNodeClick={(n) => onNodeClick?.(String(n.id))}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={(n, ctx, scale) => {
              if (scale < 0.9 && !n.isCenter) return;
              const fontSize = Math.max(10 / scale, 2);
              ctx.font = `${n.isCenter ? "600 " : ""}${fontSize}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = "rgba(100,100,110,0.95)";
              const text = String(n.name);
              ctx.fillText(text.length > 28 ? `${text.slice(0, 27)}…` : text, n.x ?? 0, (n.y ?? 0) + 6);
            }}
          />
        )}
        <ul className="sr-only">
          {nodes.map((n) => (
            <li key={n.id}>
              {n.name} ({typeLabel(n.type)}), {n.mentionCount} mentions
            </li>
          ))}
          {edges.map((e) => (
            <li key={e.id}>
              {nameById.get(e.sourceId)} {typeLabel(e.type)} {nameById.get(e.targetId)}
            </li>
          ))}
        </ul>
      </div>
      {typesPresent.length > 0 && (
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Legend">
          {typesPresent.map((t) => (
            <li key={t} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorFor(t) }} aria-hidden />
              {typeLabel(t)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
