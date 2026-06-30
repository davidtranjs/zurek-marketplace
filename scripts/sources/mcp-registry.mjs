// Source: the official MCP Registry (registry.modelcontextprotocol.io).
//
// Canonical, all-active, and — crucially — it carries full *runnable* config:
// a `packages[]` array (npm/pypi/oci → a stdio command) and/or a `remotes[]`
// array (streamable-http/sse → an http url), plus typed environment variables.
// So these become fully installable `mcp` entries, the same shape as a curated
// manifest's detail file.
//
// API shape (verified):
//   GET /v0/servers?limit=100&cursor=<nextCursor>
//   → { servers: [ { server: {...}, _meta: {...} } ], metadata: { nextCursor, count } }
//   server: { name (reverse-DNS), description, title?, version, repository?,
//             websiteUrl?, packages?[], remotes?[] }
//   _meta["io.modelcontextprotocol.registry/official"]: { status, isLatest, updatedAt, publishedAt }

import { fetchJson, repoKey } from "../agg-lib.mjs";

const BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const META_KEY = "io.modelcontextprotocol.registry/official";

// Render an Argument[] (positional or named) into argv tokens. `value`/`default`
// may contain {placeholders} that map to env vars — left literal on purpose so
// the review pane shows exactly what would run. valueHint is a label, not a
// value, so a positional with only a hint contributes nothing.
function renderArgs(list) {
  const out = [];
  for (const a of list || []) {
    if (a?.type === "named" && a.name) out.push(a.name);
    const v = a?.value ?? a?.default;
    if (v !== undefined && v !== null && v !== "") out.push(String(v));
  }
  return out;
}

function envFromPackage(pkg) {
  const env = [];
  for (const e of pkg.environmentVariables || []) {
    if (!e?.name) continue;
    const entry = { key: e.name };
    if (e.description) entry.description = e.description;
    entry.required = e.isRequired === true;
    if (e.isSecret === true) entry.secret = true;
    if (e.default !== undefined) entry.default = String(e.default);
    env.push(entry);
  }
  return env;
}

// Map one package object to a stdio { command, args, env }. Returns null for
// package kinds we can't produce a safe command for (caller falls back).
function mcpFromPackage(pkg) {
  const id = pkg.identifier;
  if (!id) return null;
  const runtimeArgs = renderArgs(pkg.runtimeArguments);
  const pkgArgs = renderArgs(pkg.packageArguments);
  const env = envFromPackage(pkg);
  const ver = pkg.version;

  switch (pkg.registryType) {
    case "npm": {
      const spec = ver ? `${id}@${ver}` : id;
      return {
        transport: "stdio",
        command: pkg.runtimeHint || "npx",
        args: [...runtimeArgs, "-y", spec, ...pkgArgs],
        env,
      };
    }
    case "pypi": {
      // uvx pins via `package==version`; bare name is the safe common case.
      const spec = ver ? `${id}==${ver}` : id;
      return {
        transport: "stdio",
        command: pkg.runtimeHint || "uvx",
        args: [...runtimeArgs, spec, ...pkgArgs],
        env,
      };
    }
    case "oci": {
      const image = ver ? `${id}:${ver}` : id;
      return {
        transport: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", ...runtimeArgs, image, ...pkgArgs],
        env,
      };
    }
    default: {
      // nuget/mcpb/unknown: only usable if upstream told us the runtime.
      if (!pkg.runtimeHint) return null;
      return { transport: "stdio", command: pkg.runtimeHint, args: [id, ...pkgArgs], env };
    }
  }
}

// Prefer a self-contained stdio package (npm > pypi > oci > other) over a remote
// endpoint, falling back to the first remote, then to a reference entry.
function buildMcp(server) {
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const order = { npm: 0, pypi: 1, oci: 2 };
  const ranked = [...packages]
    .filter((p) => (p.transport?.type ?? "stdio") === "stdio")
    .sort((a, b) => (order[a.registryType] ?? 9) - (order[b.registryType] ?? 9));
  for (const pkg of ranked) {
    const mcp = mcpFromPackage(pkg);
    if (mcp) return { mcp, reference: false };
  }

  const remote = (server.remotes || [])[0];
  if (remote?.url) {
    return {
      mcp: { transport: "http", url: remote.url, serverType: remote.type || "streamable-http" },
      reference: false,
    };
  }
  return { mcp: null, reference: true };
}

// "io.github.alice/foo-bar" → "alice"; "ai.acme/server" → "ai.acme".
function authorFromName(name) {
  const ns = String(name || "").split("/")[0] || "";
  const m = ns.match(/^io\.github\.(.+)$/i);
  return m ? m[1] : ns || "unknown";
}

function tagsFor(server, mcp) {
  const tags = new Set(["mcp"]);
  if (mcp?.transport) tags.add(mcp.transport === "http" ? "remote" : "local");
  return [...tags];
}

/** Fetch + normalize official registry servers. Returns
 *  [{ entry, updatedAt, repoKey }] — `entry` is the manifest-shaped object that
 *  gets hashed; updatedAt/repoKey are sidecar metadata for build & dedup. */
export async function fetchMcpRegistry({ max = Infinity } = {}) {
  const out = [];
  let cursor = null;
  let pages = 0;

  while (out.length < max) {
    const url = `${BASE}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await fetchJson(url);
    const servers = Array.isArray(body?.servers) ? body.servers : [];
    pages++;

    for (const row of servers) {
      const server = row?.server;
      const meta = row?._meta?.[META_KEY] || {};
      if (!server?.name) continue;
      if (meta.isLatest === false) continue; // keep only the latest version
      if (meta.status && meta.status !== "active") continue; // skip deprecated/deleted

      const { mcp, reference } = buildMcp(server);
      const repo = server.repository?.url || null;
      const homepage = server.websiteUrl || repo || undefined;

      const entry = {
        type: "mcp",
        name: server.title || server.name,
        description: (server.description || server.name).slice(0, 280),
        author: authorFromName(server.name),
        tags: tagsFor(server, mcp),
        provenance: "mcp-registry",
      };
      if (server.version) entry.version = server.version;
      if (homepage) entry.homepage = homepage;
      if (repo) entry.sourceUrl = repo;
      if (mcp) entry.mcp = mcp;
      if (reference) {
        entry.reference = true;
        entry.longDescription =
          "Listed in the official MCP Registry without a directly runnable package. See the repository for install instructions.";
      }

      out.push({
        entry,
        updatedAt: meta.updatedAt || meta.publishedAt || null,
        repoKey: repoKey(repo) || (mcp?.url ? `url:${mcp.url}` : `name:${server.name}`),
        // Carry the upstream reverse-DNS name as the id seed for a readable slug.
        idSeed: server.name,
      });
      if (out.length >= max) break;
    }

    cursor = body?.metadata?.nextCursor || null;
    if (!cursor || servers.length === 0) break;
  }

  return { entries: out, pages };
}
