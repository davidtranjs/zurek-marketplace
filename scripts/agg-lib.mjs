// Helpers for the build-time aggregation step (scripts/aggregate.mjs and the
// per-source normalizers under scripts/sources/). Kept separate from lib.mjs so
// the validate/build core stays dependency-free and offline; only this file and
// the source modules touch the network.
//
// Uses Node 20's global fetch — no npm dependencies. Raw upstream pages are
// cached under .cache/ (gitignored) so repeated local builds don't hammer the
// upstream APIs. CI checks out clean, so the cache is empty there and every
// deploy fetches fresh.

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./lib.mjs";

export const CACHE_DIR = join(ROOT, ".cache", "aggregate");

// Honour an explicit env override, else a sensible default. Numbers only.
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const REFRESH = process.env.AGG_REFRESH === "1" || process.env.AGG_REFRESH === "true";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — long enough for an iterating dev session.

function cacheFileFor(url) {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 24);
  return join(CACHE_DIR, `${key}.json`);
}

/** GET a JSON URL with on-disk caching and retry. Returns the parsed body.
 *  Throws after exhausting retries so callers can decide whether one dead page
 *  should sink the whole source (it shouldn't — see aggregate.mjs). */
export async function fetchJson(url, { ttlMs = DEFAULT_TTL_MS, retries = 3 } = {}) {
  const cacheFile = cacheFileFor(url);
  if (!REFRESH && existsSync(cacheFile)) {
    const age = Date.now() - statSync(cacheFile).mtimeMs;
    if (age < ttlMs) {
      try {
        return JSON.parse(readFileSync(cacheFile, "utf8"));
      } catch {
        // Corrupt cache entry — fall through and re-fetch.
      }
    }
  }

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "zurek-marketplace-aggregator" },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const body = await res.json();
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(body));
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(attempt * 500); // linear backoff: 0.5s, 1s, …
      }
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastErr?.message || lastErr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** kebab-case slug safe for an entry id (^[a-z0-9][a-z0-9-]*$). */
export function slugify(s) {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "entry";
}

/** Short stable hash, used to disambiguate colliding ids deterministically so
 *  the same upstream server keeps the same id (and detail URL) run-to-run. */
export function shortHash(s, len = 6) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, len);
}

/** Canonicalize a repo/homepage URL into a dedup key so the same server coming
 *  from two sources (or already curated) collapses to one entry. */
export function repoKey(url) {
  if (!url) return null;
  let s = String(url).trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return s || null;
}

/** Assign an id from `base`, disambiguating against `used` with a stable hash
 *  suffix derived from `seed` (e.g. the repo key) rather than a counter, so ids
 *  don't shuffle when the upstream list reorders. Mutates `used`. */
export function uniqueId(base, used, seed) {
  let id = slugify(base);
  if (used.has(id)) {
    id = `${slugify(base)}-${shortHash(seed || base, 6)}`;
  }
  while (used.has(id)) {
    id = `${slugify(base)}-${shortHash(seed || base, 10)}-${used.size}`;
  }
  used.add(id);
  return id;
}
