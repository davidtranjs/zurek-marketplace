// Build-time aggregation: pull MCP servers from upstream open directories,
// normalize them into the marketplace entry shape, dedupe, and hand them to the
// build. Aggregated entries are MIRRORED into the published output only — they
// never become git manifests (see ARCHITECTURE.md → curated vs aggregated).
//
// Resilience is the whole point of this layer: a source that errors, times out,
// or returns garbage logs a warning and contributes nothing. The build always
// succeeds with at least the curated entries, so a flaky upstream can never
// break a deploy.
//
// Disable entirely with ZUREK_NO_AGGREGATE=1 (used by the PR validate smoke
// test, which must stay offline and deterministic). Tune volume with
// MCP_REGISTRY_MAX / GLAMA_MAX. Force-refresh the on-disk cache with AGG_REFRESH=1.
//
// Run standalone to preview without building:  node scripts/aggregate.mjs

import { repoKey, uniqueId, envInt } from "./agg-lib.mjs";
import { fetchMcpRegistry } from "./sources/mcp-registry.mjs";
import { fetchGlama } from "./sources/glama.mjs";

// Source order matters: earlier sources win a dedup tie. The official registry
// goes first because its entries are installable; Glama only fills gaps.
// Defaults are tuned to the Phase 1 budget: a slim index entry is ~100 bytes
// gzipped, and index.json should stay under ~1 MB gzipped (~10k entries) before
// Phase 2's searchable API is needed. The official registry alone is 27k+ and
// growing, so an uncapped pull would both blow that budget and make every deploy
// a multi-minute crawl — hence a bounded default. Raise these once Phase 2 lands.
//   6000 registry + 2000 glama + curated ≈ ~825 KB gzipped, comfortably under 1 MB.
const SOURCES = [
  {
    name: "mcp-registry",
    run: () => fetchMcpRegistry({ max: envInt("MCP_REGISTRY_MAX", 6000) }),
  },
  {
    name: "glama",
    run: () => fetchGlama({ max: envInt("GLAMA_MAX", 2000) }),
  },
];

export function aggregationEnabled() {
  return !(process.env.ZUREK_NO_AGGREGATE === "1" || process.env.ZUREK_NO_AGGREGATE === "true");
}

/**
 * @param {{ reservedIds?: Set<string>, reservedRepoKeys?: Set<string> }} ctx
 *   ids/repo-keys already claimed by curated git entries; aggregated entries
 *   never clobber a curated one.
 * @returns {Promise<Array<{ entry, updatedAt }>>}
 */
export async function aggregate({ reservedIds = new Set(), reservedRepoKeys = new Set() } = {}) {
  if (!aggregationEnabled()) {
    console.log("• aggregation disabled (ZUREK_NO_AGGREGATE) — curated entries only");
    return [];
  }

  const usedIds = new Set(reservedIds);
  const seenKeys = new Set(reservedRepoKeys);
  const merged = [];
  const stats = [];

  for (const source of SOURCES) {
    let fetched = [];
    let pages = 0;
    try {
      const res = await source.run();
      fetched = res.entries || [];
      pages = res.pages || 0;
    } catch (err) {
      console.warn(`⚠ source "${source.name}" failed — skipping it: ${err.message}`);
      stats.push({ source: source.name, fetched: 0, added: 0, failed: true });
      continue;
    }

    let added = 0;
    let dupes = 0;
    for (const item of fetched) {
      const key = item.repoKey || null;
      if (key && seenKeys.has(key)) {
        dupes++;
        continue;
      }
      if (key) seenKeys.add(key);

      const id = uniqueId(item.idSeed || item.entry.name, usedIds, key || item.entry.name);
      merged.push({ entry: { id, ...item.entry }, updatedAt: item.updatedAt });
      added++;
    }

    stats.push({ source: source.name, fetched: fetched.length, added, dupes, pages });
    console.log(
      `• ${source.name}: ${added} added` +
        (dupes ? `, ${dupes} deduped` : "") +
        ` (from ${fetched.length} fetched over ${pages} page${pages === 1 ? "" : "s"})`,
    );
  }

  console.log(`• aggregated ${merged.length} upstream entr${merged.length === 1 ? "y" : "ies"}`);
  return merged;
}

// ---- standalone preview -----------------------------------------------------
// `node scripts/aggregate.mjs` fetches and prints a summary + a sample, without
// touching public/. Handy for sanity-checking a source or the caps.
if (import.meta.url === `file://${process.argv[1]}`) {
  const entries = await aggregate();
  const byProvenance = {};
  let installable = 0;
  for (const { entry } of entries) {
    byProvenance[entry.provenance] = (byProvenance[entry.provenance] || 0) + 1;
    if (entry.mcp?.command || entry.mcp?.url) installable++;
  }
  console.log("\nby source:", byProvenance);
  console.log(`installable: ${installable} / ${entries.length}`);
  console.log("\nsample:");
  for (const { entry } of entries.slice(0, 5)) {
    const run = entry.mcp?.command
      ? `${entry.mcp.command} ${(entry.mcp.args || []).join(" ")}`
      : entry.mcp?.url || "(reference — see repo)";
    console.log(`  - [${entry.provenance}] ${entry.id}: ${run}`);
  }
}
