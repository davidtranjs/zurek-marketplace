// Builds the marketplace's published artifacts from every entries/<id>/manifest.json.
// Run by CI on push to main and locally with `node scripts/build-registry.mjs`.
// Validates first and refuses to build on error.
//
// All outputs go into public/ — a generated, gitignored static site published to
// Cloudflare Pages. Nothing is committed back to the repo (no CI push to main).
//
// Outputs (all under public/):
//   registry.json              — LEGACY full dump (every entry, full payload) for
//                                 older clients. Deprecated: it grows linearly with
//                                 the catalog and is the file we're moving clients off of.
//     meta.json                — tiny: { version, generatedAt, count, indexHash }.
//                                 The only file a client must always re-fetch.
//     index.json               — slim list (INDEX_FIELDS + hash) used to render the
//                                 list, search, and filters. No heavy detail.
//     detail/<id>.<hash>.json  — full per-entry detail. Content-addressed (the hash
//                                 is in the filename) so it's safe to cache forever.
//     entries/<id>/...         — vendored content files (downloaded at install time).
//     _headers                 — Cloudflare Pages cache rules (immutable vs revalidate).

import { writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  ROOT,
  PUBLIC_DIR,
  ENTRIES_DIR,
  loadAll,
  validateManifest,
  collectFiles,
  contentHash,
  vendoredContentHash,
  gitLastModified,
  slimEntry,
} from "./lib.mjs";
import { aggregate } from "./aggregate.mjs";
import { repoKey } from "./agg-lib.mjs";

// Cloudflare Pages cache rules. Detail files are content-addressed (the hash is
// in the filename), so each version has a unique URL and can be cached forever.
// Everything else is revalidated cheaply via ETag. More specific paths win.
const HEADERS = `# Cloudflare Pages cache rules — see ARCHITECTURE.md.

/detail/*
  Cache-Control: public, max-age=31536000, immutable

/meta.json
  Cache-Control: public, max-age=0, must-revalidate

/index.json
  Cache-Control: public, max-age=0, must-revalidate

/entries/*
  Cache-Control: public, max-age=0, must-revalidate
`;

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { manifests, allIds } = loadAll();

  const errors = [];
  for (const { folder, manifest } of manifests) {
    errors.push(...validateManifest(manifest, folder, allIds));
  }
  if (errors.length) {
    console.error(`✗ refusing to build — ${errors.length} validation error(s):`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();

  // Curated entries (git is the source of truth): the manifest plus, for bundled
  // entries, the list of vendored files. updatedAt comes from git history; these
  // carry provenance "curated" so clients can tell them apart from mirrored data.
  const curated = manifests.map(({ folder, manifest }) => {
    const entry = { provenance: "curated", ...manifest };
    if (manifest.source && manifest.source.type === "bundled") {
      entry.files = collectFiles(folder);
    }
    return { folder, entry, updatedAt: gitLastModified(folder) || generatedAt };
  });

  // Aggregated entries (mirrored from upstream directories at build time, never
  // committed). Reserve curated ids + repo keys so an upstream entry can never
  // clobber or duplicate a curated one. The whole step is best-effort: if every
  // source is down, this returns [] and we ship just the curated catalog.
  const reservedIds = new Set(curated.map((c) => c.entry.id));
  const reservedRepoKeys = new Set();
  for (const { entry } of curated) {
    const k = repoKey(entry.sourceUrl) || repoKey(entry.homepage);
    if (k) reservedRepoKeys.add(k);
  }
  const aggregated = (await aggregate({ reservedIds, reservedRepoKeys })).map((a) => ({
    folder: null,
    entry: a.entry,
    updatedAt: a.updatedAt || generatedAt,
  }));

  // One unified, id-sorted set feeds every output below — curated and aggregated
  // entries are emitted through exactly the same path.
  const fullEntries = [...curated, ...aggregated].sort((a, b) =>
    a.entry.id.localeCompare(b.entry.id),
  );

  // Start from a clean output dir, then write everything into public/.
  rmSync(PUBLIC_DIR, { recursive: true, force: true });

  // --- Legacy: registry.json (full dump) ---------------------------------
  // Deployed alongside the split index (served at /registry.json) for older
  // clients. NOT committed to git — it's a generated artifact like the rest.
  writeJson(join(PUBLIC_DIR, "registry.json"), {
    version: 1,
    generatedAt,
    entries: fullEntries.map((e) => e.entry),
  });

  // --- New: split index + content-addressed detail into public/ ----------

  const index = [];
  for (const { folder, entry, updatedAt } of fullEntries) {
    // Hash the stable content — the manifest plus the *contents* of any vendored
    // files — but not generatedAt/updatedAt. So an unchanged entry keeps the same
    // hash run-to-run, which is what makes its detail file cacheable forever.
    const filesContentHash =
      folder && entry.files ? vendoredContentHash(folder, entry.files) : null;
    const hash = contentHash({ entry, filesContentHash });
    const detail = { ...entry, hash, updatedAt };

    // Content-addressed: the client builds this URL from the index entry's id+hash.
    writeJson(join(PUBLIC_DIR, "detail", `${entry.id}.${hash}.json`), detail);

    // Vendored content, fetched at install time from /entries/<id>/<file>.
    // Aggregated entries have no folder and vendor nothing.
    for (const rel of folder ? entry.files || [] : []) {
      cpSync(
        join(ENTRIES_DIR, folder, rel),
        join(PUBLIC_DIR, "entries", entry.id, rel),
        { recursive: true },
      );
    }

    index.push({ ...slimEntry(entry), hash, updatedAt });
  }

  writeJson(join(PUBLIC_DIR, "index.json"), index);

  // meta.json is tiny and always fresh; clients diff indexHash to decide whether
  // to re-download index.json at all.
  const indexHash = contentHash(index);
  writeJson(join(PUBLIC_DIR, "meta.json"), {
    version: 1,
    generatedAt,
    count: index.length,
    indexHash,
  });

  writeFileSync(join(PUBLIC_DIR, "_headers"), HEADERS);

  const n = index.length;
  console.log(`✓ built public/ (${n} entr${n === 1 ? "y" : "ies"}, indexHash ${indexHash})`);
}

await main();
