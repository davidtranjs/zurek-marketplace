// Source: Glama (glama.ai/api/mcp/v1/servers).
//
// Glama indexes ~37k MCP servers — huge reach — but its API (both list and
// detail) only exposes repo URL, license, attributes, and an env-var *schema*.
// It does NOT carry a runnable package/command or any popularity score. So
// Glama entries are emitted as REFERENCE entries: a labelled pointer to the
// upstream repo with env-var hints, not a one-click install. aggregate.mjs
// dedupes them against the official registry, so Glama only contributes servers
// the registry doesn't already cover.
//
// Because there's no popularity field to rank by, the "top-N" cap takes servers
// in the API's own order after a quality gate (must have description + repo).
//
// API shape (verified):
//   GET /api/mcp/v1/servers?first=100&after=<endCursor>
//   → { pageInfo: { endCursor, hasNextPage }, servers: [ {
//        id, name, namespace, slug, description, attributes[],
//        repository: { url }, spdxLicense: { name, url },
//        environmentVariablesJsonSchema: { properties, required } } ] }

import { fetchJson, repoKey } from "../agg-lib.mjs";

const BASE = "https://glama.ai/api/mcp/v1/servers";
const SECRETY = /secret|token|key|password|passwd|credential|api[-_ ]?key/i;

function envFromSchema(schema) {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(props).map(([key, def]) => {
    const entry = { key };
    if (def?.description) entry.description = def.description;
    entry.required = required.has(key);
    if (SECRETY.test(key)) entry.secret = true;
    return entry;
  });
}

// "hosting:local-only" → "local-only"; plain attrs pass through.
function tagsFrom(server) {
  const tags = new Set(["mcp"]);
  for (const a of server.attributes || []) {
    const t = String(a).split(":").pop();
    if (t) tags.add(t);
  }
  return [...tags];
}

/** Fetch + normalize Glama servers into reference entries. Returns
 *  [{ entry, updatedAt, repoKey, idSeed }]. */
export async function fetchGlama({ max = 3000 } = {}) {
  if (max <= 0) return { entries: [], pages: 0 };

  const out = [];
  let after = null;
  let pages = 0;

  while (out.length < max) {
    const url = `${BASE}?first=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const body = await fetchJson(url);
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    pages++;

    for (const server of servers) {
      const repo = server.repository?.url || null;
      // Quality gate: skip the thin, link-less rows.
      if (!server.name || !server.description || !repo) continue;

      const env = envFromSchema(server.environmentVariablesJsonSchema);
      const entry = {
        type: "mcp",
        name: server.name,
        description: String(server.description).slice(0, 280),
        author: server.namespace || "unknown",
        homepage: repo,
        sourceUrl: repo,
        tags: tagsFrom(server),
        provenance: "glama",
        reference: true,
        longDescription:
          "Indexed by Glama. No runnable package is published via Glama's API — open the repository for install instructions.",
      };
      if (server.spdxLicense?.name) entry.license = server.spdxLicense.name;
      // Surface env-var hints even though there's no command to attach them to.
      if (env.length) entry.mcp = { transport: "stdio", env };

      out.push({
        entry,
        updatedAt: null,
        repoKey: repoKey(repo),
        idSeed: `${server.namespace || ""}-${server.slug || server.name}`,
      });
      if (out.length >= max) break;
    }

    after = body?.pageInfo?.hasNextPage ? body?.pageInfo?.endCursor : null;
    if (!after || servers.length === 0) break;
  }

  return { entries: out, pages };
}
