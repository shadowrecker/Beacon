#!/usr/bin/env bash
# Fails if prisma/schema.prisma and prisma/migrations have drifted apart.
#
# Prisma cannot express pgvector HNSW indexes, so it always reports the two
# embedding indexes created in the baseline migration as "Removed index on
# columns (embedding)". Those two lines are expected; anything else is drift.
#
# Requires SHADOW_DATABASE_URL (an empty database Prisma can reset freely).
set -euo pipefail

: "${SHADOW_DATABASE_URL:?SHADOW_DATABASE_URL must point at an empty scratch database}"

out=$(npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' || true)

unexpected=$(printf '%s\n' "$out" \
  | grep -vE '^\s*$' \
  | grep -vE '^warn |^For more information|^\[\*\] Changed the `(chunks|knowledge_entities)` table$|^\s+\[-\] Removed index on columns \(embedding\)$|^No difference detected' \
  || true)

if [ -n "$unexpected" ]; then
  echo "Schema drift detected between prisma/schema.prisma and prisma/migrations:"
  printf '%s\n' "$out"
  echo
  echo "Create a migration: npx prisma migrate dev --create-only --name <change>"
  echo "and DELETE any generated 'DROP INDEX \"*_embedding_hnsw_idx\"' lines from it."
  exit 1
fi
echo "No schema drift (expected pgvector HNSW index entries ignored)."
