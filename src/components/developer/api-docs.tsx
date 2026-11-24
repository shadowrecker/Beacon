/**
 * Readable API reference rendered from the OpenAPI document (the same one served
 * at /api/v1/openapi.json, generated from the route definitions). Pure
 * rendering, no client state, so it works as a server component.
 */
import type { OpenApiDocument, OpenApiOperation } from "@/server/api/openapi";

type Schema = Record<string, unknown>;

const METHOD_STYLES: Record<string, string> = {
  get: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  post: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  patch: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  delete: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

function refName(ref: unknown): string | null {
  return typeof ref === "string" ? ref.replace("#/components/schemas/", "") : null;
}

function resolve(schema: Schema, components: Record<string, Schema>): Schema {
  const name = refName(schema.$ref);
  return name && components[name] ? components[name] : schema;
}

function typeLabel(schema: Schema, components: Record<string, Schema>): string {
  const name = refName(schema.$ref);
  if (name) return name;
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in schema) return JSON.stringify(schema.const);
  const t = schema.type;
  if (t === "array") {
    const items = (schema.items ?? {}) as Schema;
    return `${typeLabel(items, components)}[]`;
  }
  if (Array.isArray(t)) return t.join(" | ");
  if (typeof t === "string") return schema.format ? `${t} (${schema.format})` : t;
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map((s) => typeLabel(s, components)).join(" | ");
  return "any";
}

function constraints(schema: Schema): string {
  const parts: string[] = [];
  if (typeof schema.minLength === "number") parts.push(`min length ${schema.minLength}`);
  if (typeof schema.maxLength === "number") parts.push(`max length ${schema.maxLength}`);
  if (typeof schema.minimum === "number") parts.push(`≥ ${schema.minimum}`);
  if (typeof schema.maximum === "number") parts.push(`≤ ${schema.maximum}`);
  if (typeof schema.maxItems === "number") parts.push(`max ${schema.maxItems} items`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts.join(", ");
}

/** Flatten an object schema into rows (nested objects and arrays of objects are indented). */
function fieldRows(
  schema: Schema,
  components: Record<string, Schema>,
  prefix = "",
  depth = 0,
  seen: Set<string> = new Set()
): Array<{ name: string; type: string; required: boolean; notes: string; depth: number }> {
  const name = refName(schema.$ref);
  if (name) {
    if (seen.has(name) || depth > 4) return [];
    seen = new Set(seen).add(name);
  }
  const s = resolve(schema, components);
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const required = new Set((s.required as string[] | undefined) ?? []);
  const rows: Array<{ name: string; type: string; required: boolean; notes: string; depth: number }> = [];
  for (const [key, raw] of Object.entries(props)) {
    const prop = raw as Schema;
    const full = prefix ? `${prefix}.${key}` : key;
    const notes = [typeof prop.description === "string" ? prop.description : "", constraints(prop)].filter(Boolean).join(" · ");
    rows.push({ name: full, type: typeLabel(prop, components), required: required.has(key), notes, depth });
    const resolved = resolve(prop, components);
    if (resolved.type === "object" && resolved.properties) {
      rows.push(...fieldRows(prop, components, full, depth + 1, seen));
    } else if (resolved.type === "array") {
      const items = (resolved.items ?? {}) as Schema;
      const inner = resolve(items, components);
      if (inner.type === "object" && inner.properties) rows.push(...fieldRows(items, components, `${full}[]`, depth + 1, seen));
    }
  }
  return rows;
}

function FieldTable({ schema, components, caption }: { schema: Schema; components: Record<string, Schema>; caption: string }) {
  const rows = fieldRows(schema, components);
  if (rows.length === 0) return <p className="text-sm text-gray-500">{typeLabel(schema, components)}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th scope="col" className="pb-1 pr-3 font-medium">Field</th>
            <th scope="col" className="pb-1 pr-3 font-medium">Type</th>
            <th scope="col" className="pb-1 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t align-top dark:border-gray-800">
              <td className="py-1 pr-3 font-mono text-xs" style={{ paddingLeft: `${r.depth * 1}rem` }}>
                {r.name}
                {r.required && <span className="text-red-600" aria-label="required"> *</span>}
              </td>
              <td className="py-1 pr-3 font-mono text-xs text-gray-600 dark:text-gray-400">{r.type}</td>
              <td className="py-1 text-xs text-gray-600 dark:text-gray-400">{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inline({ text }: { text: string }) {
  // Render `code` spans from the spec's descriptions; everything else is plain text.
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-gray-100 px-1 font-mono text-xs dark:bg-gray-900">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function anchor(method: string, path: string): string {
  return `${method}-${path}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
}

function Operation({ method, path, op, components, server }: { method: string; path: string; op: OpenApiOperation; components: Record<string, Schema>; server: string }) {
  const success = Object.entries(op.responses).find(([code]) => code.startsWith("2"));
  const errors = Object.keys(op.responses).filter((c) => !c.startsWith("2"));
  const id = anchor(method, path);
  return (
    <article id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-3 rounded-lg border p-4 dark:border-gray-800">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 font-mono text-xs font-bold uppercase ${METHOD_STYLES[method] ?? ""}`}>{method}</span>
          <code className="font-mono text-sm">{path}</code>
          <span className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-400">scope: {op["x-required-scope"]}</span>
        </div>
        <h3 id={`${id}-title`} className="text-base font-semibold">
          {op.summary}
        </h3>
        {op.description && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            <Inline text={op.description} />
          </p>
        )}
      </header>
      {op.parameters.length > 0 && (
        <section className="space-y-1">
          <h4 className="text-sm font-medium">Parameters</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Parameters for {op.operationId}</caption>
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th scope="col" className="pb-1 pr-3 font-medium">Name</th>
                  <th scope="col" className="pb-1 pr-3 font-medium">In</th>
                  <th scope="col" className="pb-1 pr-3 font-medium">Type</th>
                  <th scope="col" className="pb-1 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}-${p.name}`} className="border-t align-top dark:border-gray-800">
                    <td className="py-1 pr-3 font-mono text-xs">
                      {p.name}
                      {p.required && <span className="text-red-600" aria-label="required"> *</span>}
                    </td>
                    <td className="py-1 pr-3 text-xs">{p.in}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-gray-600 dark:text-gray-400">{typeLabel(p.schema, components)}</td>
                    <td className="py-1 text-xs text-gray-600 dark:text-gray-400">
                      {[p.description ? p.description : "", constraints(p.schema)].filter(Boolean).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {op.requestBody && (
        <section className="space-y-1">
          <h4 className="text-sm font-medium">Request body (application/json)</h4>
          <FieldTable schema={op.requestBody.content["application/json"].schema} components={components} caption={`Request body for ${op.operationId}`} />
        </section>
      )}
      {success && success[1].content && (
        <section className="space-y-1">
          <h4 className="text-sm font-medium">
            Response {success[0]} <span className="font-normal text-gray-500">{success[1].description}</span>
          </h4>
          <FieldTable schema={success[1].content["application/json"].schema} components={components} caption={`Response for ${op.operationId}`} />
        </section>
      )}
      <p className="text-xs text-gray-500">Errors: {errors.join(", ")} (body: {"{ error: { code, message, requestId, details? } }"})</p>
      <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
        <code>{`curl -X ${method.toUpperCase()} "${server}${path}" \\\n  -H "Authorization: Bearer $BEACON_API_KEY"${op.requestBody ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '{…}'` : ""}`}</code>
      </pre>
    </article>
  );
}

export function ApiDocs({ doc }: { doc: OpenApiDocument }) {
  const components = doc.components.schemas as Record<string, Schema>;
  const server = doc.servers[0]?.url ?? "/api/v1";
  const byTag = doc.tags.map((tag) => ({
    tag,
    ops: Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => op.tags.includes(tag.name))
        .map(([method, op]) => ({ path, method, op }))
    ),
  }));

  return (
    <div className="grid gap-8 lg:grid-cols-[14rem_1fr]">
      <nav aria-label="API reference" className="lg:sticky lg:top-4 lg:self-start">
        <ul className="space-y-3 text-sm">
          <li>
            <a href="#overview" className="font-medium hover:underline">
              Overview
            </a>
          </li>
          {byTag.map(({ tag, ops }) => (
            <li key={tag.name}>
              <a href={`#tag-${tag.name}`} className="font-medium hover:underline">
                {tag.name}
              </a>
              <ul className="mt-1 space-y-1 border-l pl-3 dark:border-gray-800">
                {ops.map(({ path, method, op }) => (
                  <li key={`${method} ${path}`}>
                    <a href={`#${anchor(method, path)}`} className="text-gray-600 hover:underline dark:text-gray-400">
                      {op.summary}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 space-y-10">
        <section id="overview" aria-labelledby="overview-title" className="space-y-3">
          <h2 id="overview-title" className="text-xl font-semibold">
            {doc.info.title} <span className="text-sm font-normal text-gray-500">v{doc.info.version} · OpenAPI {doc.openapi}</span>
          </h2>
          {doc.info.description.split("\n").filter(Boolean).map((line, i) => (
            <p key={i} className="text-sm text-gray-700 dark:text-gray-300">
              <Inline text={line} />
            </p>
          ))}
          <p className="text-sm">
            Base URL: <code className="rounded bg-gray-100 px-1 font-mono text-xs dark:bg-gray-900">{server}</code> · Machine-readable spec:{" "}
            <a className="text-blue-600 underline dark:text-blue-400" href="/api/v1/openapi.json">
              /api/v1/openapi.json
            </a>
          </p>
        </section>
        {byTag.map(({ tag, ops }) => (
          <section key={tag.name} id={`tag-${tag.name}`} aria-labelledby={`tag-${tag.name}-title`} className="scroll-mt-20 space-y-4">
            <div>
              <h2 id={`tag-${tag.name}-title`} className="text-xl font-semibold">
                {tag.name}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{tag.description}</p>
            </div>
            {ops.map(({ path, method, op }) => (
              <Operation key={`${method} ${path}`} method={method} path={path} op={op} components={components} server={server} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
