// Shared helpers for the marketplace tooling. Dependency-free — Node `fs` only,
// so CI needs nothing more than `actions/setup-node` and contributors don't
// have to run `npm install` to validate their entry locally.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ENTRIES_DIR = join(ROOT, "entries");
export const PUBLIC_DIR = join(ROOT, "public");

export const ENTRY_TYPES = ["mcp", "skill", "agent", "bundle"];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// Fields the list/search/filter views need. Everything heavy or structural
// (longDescription, mcp, source, install, items, files) is left out of the
// index and fetched lazily from the per-entry detail file instead.
export const INDEX_FIELDS = [
  "id",
  "type",
  "name",
  "description",
  "author",
  "tags",
  "version",
  "license",
  "homepage",
  // Aggregation metadata: where the entry came from ("curated" | "mcp-registry"
  // | "glama") and whether it's a non-installable reference pointer. In the
  // index so clients can badge/filter by source without fetching detail.
  "provenance",
  "reference",
];

/** Deterministic JSON: object keys sorted recursively, so the hash of equal
 * content is stable across runs and machines. */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Short content hash of any JSON-serializable value. Used as an immutable
 * cache key for per-entry detail and to detect index changes. */
export function contentHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** Short hash of the *contents* of an entry's vendored files. Folded into the
 * entry hash so editing a vendored file (without touching the manifest) still
 * changes the hash — otherwise such edits would never invalidate client caches. */
export function vendoredContentHash(folder, files) {
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(ENTRIES_DIR, folder, rel)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** ISO timestamp of the last commit touching an entry folder, or null if git
 * history isn't available (e.g. a shallow checkout or a fresh untracked entry). */
export function gitLastModified(folder) {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%cI", "--", `entries/${folder}`],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Projects a full entry down to the slim shape stored in index.json. */
export function slimEntry(entry) {
  const out = {};
  for (const f of INDEX_FIELDS) {
    if (entry[f] !== undefined) {
      out[f] = entry[f];
    }
  }
  return out;
}

/** Folder names under entries/, sorted. */
export function listEntryDirs() {
  if (!existsSync(ENTRIES_DIR)) {
    return [];
  }
  return readdirSync(ENTRIES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function readManifest(folder) {
  const file = join(ENTRIES_DIR, folder, "manifest.json");
  if (!existsSync(file)) {
    throw new Error(`entries/${folder}: missing manifest.json`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`entries/${folder}/manifest.json: invalid JSON — ${err.message}`);
  }
}

/** Relative file paths vendored inside an entry folder, excluding manifest.json. */
export function collectFiles(folder) {
  const base = join(ENTRIES_DIR, folder);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        const rel = relative(base, abs).split("\\").join("/");
        if (rel !== "manifest.json") {
          out.push(rel);
        }
      }
    }
  };
  walk(base);
  return out.sort();
}

/** Returns an array of human-readable error strings (empty = valid). */
export function validateManifest(m, folder, allIds) {
  const errs = [];
  const at = `entries/${folder}/manifest.json`;
  const req = (cond, msg) => {
    if (!cond) {
      errs.push(`${at}: ${msg}`);
    }
  };

  req(typeof m.id === "string" && ID_RE.test(m.id), `"id" must be lowercase kebab-case`);
  req(m.id === folder, `"id" (${m.id}) must match the folder name (${folder})`);
  req(ENTRY_TYPES.includes(m.type), `"type" must be one of ${ENTRY_TYPES.join(", ")}`);
  req(typeof m.name === "string" && m.name.length > 0, `"name" is required`);
  req(typeof m.description === "string" && m.description.length > 0, `"description" is required`);
  req(typeof m.author === "string" && m.author.length > 0, `"author" is required`);

  if (m.type === "mcp") {
    const mcp = m.mcp || {};
    const transport = mcp.transport || "stdio";
    req(["stdio", "http"].includes(transport), `mcp.transport must be "stdio" or "http"`);
    if (transport === "stdio") {
      req(!!mcp.command, `mcp.command is required for stdio transport`);
    }
    if (transport === "http") {
      req(!!mcp.url, `mcp.url is required for http transport`);
    }
    if (mcp.env !== undefined) {
      req(Array.isArray(mcp.env), `mcp.env must be an array`);
      for (const v of Array.isArray(mcp.env) ? mcp.env : []) {
        req(!!v.key, `mcp.env entries need a "key"`);
      }
    }
  } else if (m.type === "skill" || m.type === "agent") {
    const src = m.source || {};
    req(["bundled", "github"].includes(src.type), `source.type must be "bundled" or "github"`);
    if (src.type === "github") {
      req(!!src.repo, `source.repo is required for a github source (e.g. "owner/name")`);
      req(!!src.path, `source.path is required for a github source`);
    } else if (src.type === "bundled") {
      req(collectFiles(folder).length > 0, `a bundled ${m.type} must vendor at least one content file`);
    }
  } else if (m.type === "bundle") {
    req(Array.isArray(m.items) && m.items.length > 0, `bundle "items" must be a non-empty array`);
    for (const it of Array.isArray(m.items) ? m.items : []) {
      req(it && typeof it.id === "string", `bundle items need an "id"`);
      if (it && it.id) {
        req(allIds.has(it.id), `bundle item "${it.id}" does not resolve to a known entry`);
      }
    }
  }

  return errs;
}

export function loadAll() {
  const folders = listEntryDirs();
  const manifests = folders.map((folder) => ({ folder, manifest: readManifest(folder) }));
  const allIds = new Set(manifests.map((x) => x.manifest.id).filter(Boolean));
  return { manifests, allIds };
}
