/**
 * Read-side graph queries. Every query takes the org ID and filters both
 * relation endpoints by it, and every traversal is bounded (depth, nodes and
 * edges per level), so a hub entity can never produce an unbounded response.
 */
import type { EntityType, RelationType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";

export const MAX_NEIGHBORHOOD_DEPTH = 2;
export const MAX_NEIGHBORHOOD_NODES = 150;
const EDGES_PER_LEVEL = 300;
export const MAX_PATH_DEPTH = 4;
const PATH_EDGES_PER_LEVEL = 2_000;
const PATH_MAX_VISITED = 10_000;

export interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  mentionCount: number;
  depth: number;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationType;
  strength: number;
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the node/edge caps cut the neighborhood short. */
  truncated: boolean;
}

const edgeSelect = { id: true, sourceId: true, targetId: true, type: true, strength: true } as const;
const nodeSelect = { id: true, name: true, type: true, mentionCount: true } as const;

/** Breadth-first neighborhood up to `depth` hops (≤ 2), within the org. Null if the entity is not in the org. */
export async function getNeighborhood(orgId: string, entityId: string, depth: number, db: DbClient = prisma): Promise<Neighborhood | null> {
  const maxDepth = Math.max(1, Math.min(MAX_NEIGHBORHOOD_DEPTH, Math.floor(depth)));
  const center = await db.knowledgeEntity.findFirst({ where: { id: entityId, orgId }, select: nodeSelect });
  if (!center) return null;

  const depthOf = new Map<string, number>([[center.id, 0]]);
  const edges = new Map<string, GraphEdge>();
  let frontier = [center.id];
  let truncated = false;

  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const level = await db.knowledgeRelation.findMany({
      where: {
        OR: [{ sourceId: { in: frontier } }, { targetId: { in: frontier } }],
        source: { orgId },
        target: { orgId },
      },
      orderBy: [{ strength: "desc" }, { id: "asc" }],
      take: EDGES_PER_LEVEL + 1,
      select: edgeSelect,
    });
    if (level.length > EDGES_PER_LEVEL) {
      truncated = true;
      level.length = EDGES_PER_LEVEL;
    }
    const next: string[] = [];
    for (const e of level) {
      for (const id of [e.sourceId, e.targetId]) {
        if (depthOf.has(id)) continue;
        if (depthOf.size >= MAX_NEIGHBORHOOD_NODES) {
          truncated = true;
          continue;
        }
        depthOf.set(id, d);
        next.push(id);
      }
      if (depthOf.has(e.sourceId) && depthOf.has(e.targetId)) edges.set(e.id, e);
    }
    frontier = next;
  }

  const ids = [...depthOf.keys()];
  const rows = await db.knowledgeEntity.findMany({ where: { id: { in: ids }, orgId }, select: nodeSelect });
  const nodes = rows.map((n) => ({ ...n, depth: depthOf.get(n.id) ?? 0 })).sort((a, b) => a.depth - b.depth || b.mentionCount - a.mentionCount);
  const present = new Set(nodes.map((n) => n.id));
  return {
    center: { ...center, depth: 0 },
    nodes,
    edges: [...edges.values()].filter((e) => present.has(e.sourceId) && present.has(e.targetId)),
    truncated,
  };
}

export interface PathStep {
  node: Omit<GraphNode, "depth">;
  /** Relation that connects the previous node to this one (null for the first node). */
  relation: GraphEdge | null;
}

/**
 * Shortest undirected path between two entities of the same org, by BFS up to
 * `maxDepth` (≤ 4) hops. Returns null when either endpoint is not in the org,
 * and an empty array when no path exists within the bound.
 */
export async function shortestPath(orgId: string, fromId: string, toId: string, maxDepth = MAX_PATH_DEPTH, db: DbClient = prisma): Promise<PathStep[] | null> {
  const endpoints = await db.knowledgeEntity.findMany({ where: { id: { in: [fromId, toId] }, orgId }, select: nodeSelect });
  const uniqueEndpoints = new Set([fromId, toId]).size;
  if (endpoints.length !== uniqueEndpoints) return null;
  if (fromId === toId) return [{ node: endpoints[0], relation: null }];

  const limit = Math.max(1, Math.min(MAX_PATH_DEPTH, Math.floor(maxDepth)));
  const parent = new Map<string, { prev: string; edge: GraphEdge } | null>([[fromId, null]]);
  let frontier = [fromId];
  let found = false;

  for (let d = 1; d <= limit && frontier.length > 0 && !found; d++) {
    const level = await db.knowledgeRelation.findMany({
      where: {
        OR: [{ sourceId: { in: frontier } }, { targetId: { in: frontier } }],
        source: { orgId },
        target: { orgId },
      },
      orderBy: [{ strength: "desc" }, { id: "asc" }],
      take: PATH_EDGES_PER_LEVEL,
      select: edgeSelect,
    });
    const frontierSet = new Set(frontier);
    const next: string[] = [];
    for (const e of level) {
      const pairs: Array<[string, string]> = [];
      if (frontierSet.has(e.sourceId)) pairs.push([e.sourceId, e.targetId]);
      if (frontierSet.has(e.targetId)) pairs.push([e.targetId, e.sourceId]);
      for (const [from, to] of pairs) {
        if (parent.has(to)) continue;
        if (parent.size >= PATH_MAX_VISITED) break;
        parent.set(to, { prev: from, edge: e });
        next.push(to);
        if (to === toId) found = true;
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!parent.has(toId)) return [];

  const chain: Array<{ id: string; edge: GraphEdge | null }> = [];
  let cursor: string | undefined = toId;
  while (cursor) {
    const p = parent.get(cursor);
    chain.unshift({ id: cursor, edge: p ? p.edge : null });
    cursor = p ? p.prev : undefined;
  }
  const rows = await db.knowledgeEntity.findMany({ where: { id: { in: chain.map((c) => c.id) }, orgId }, select: nodeSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const steps: PathStep[] = [];
  for (const c of chain) {
    const node = byId.get(c.id);
    if (!node) return [];
    steps.push({ node, relation: c.edge });
  }
  return steps;
}

export interface GraphStats {
  entityCount: number;
  relationCount: number;
  pendingMergeSuggestions: number;
  queryCount: number;
  byType: Array<{ type: EntityType; count: number }>;
  byRelationType: Array<{ type: RelationType; count: number }>;
}

export async function graphStats(orgId: string, db: DbClient = prisma): Promise<GraphStats> {
  const [entityCount, relationCount, pendingMergeSuggestions, queryCount, byType, byRelationType] = await Promise.all([
    db.knowledgeEntity.count({ where: { orgId } }),
    db.knowledgeRelation.count({ where: { source: { orgId } } }),
    db.knowledgeMergeSuggestion.count({ where: { orgId, status: "PENDING" } }),
    db.knowledgeQuery.count({ where: { orgId } }),
    db.knowledgeEntity.groupBy({ by: ["type"], where: { orgId }, _count: { _all: true } }),
    db.$queryRaw<Array<{ type: RelationType; count: bigint }>>`
      SELECT r.type::text AS type, count(*) AS count
      FROM knowledge_relations r JOIN knowledge_entities s ON s.id = r."sourceId"
      WHERE s."orgId" = ${orgId}
      GROUP BY r.type ORDER BY count DESC`,
  ]);
  return {
    entityCount,
    relationCount,
    pendingMergeSuggestions,
    queryCount,
    byType: byType.map((t) => ({ type: t.type, count: t._count._all })).sort((a, b) => b.count - a.count),
    byRelationType: byRelationType.map((r) => ({ type: r.type, count: Number(r.count) })),
  };
}

export interface Hub {
  id: string;
  name: string;
  type: EntityType;
  mentionCount: number;
  degree: number;
}

/** Entities with the most relations (ties broken by mentions). */
export async function topHubs(orgId: string, limit: number, db: DbClient = prisma): Promise<Hub[]> {
  const take = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = await db.$queryRaw<Array<{ id: string; name: string; type: EntityType; mentionCount: number; degree: bigint }>>`
    WITH ends AS (
      SELECT r."sourceId" AS id FROM knowledge_relations r JOIN knowledge_entities s ON s.id = r."sourceId" WHERE s."orgId" = ${orgId}
      UNION ALL
      SELECT r."targetId" AS id FROM knowledge_relations r JOIN knowledge_entities t ON t.id = r."targetId" WHERE t."orgId" = ${orgId}
    ), deg AS (
      SELECT id, count(*) AS degree FROM ends GROUP BY id
    )
    SELECT e.id, e.name, e.type::text AS type, e."mentionCount" AS "mentionCount", COALESCE(deg.degree, 0) AS degree
    FROM knowledge_entities e LEFT JOIN deg ON deg.id = e.id
    WHERE e."orgId" = ${orgId}
    ORDER BY degree DESC, e."mentionCount" DESC, e.id ASC
    LIMIT ${take}`;
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, mentionCount: r.mentionCount, degree: Number(r.degree) }));
}
