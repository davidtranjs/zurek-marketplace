// Builds the marketplace's published artifacts from every entries/<id>/manifest.json.
// Run by CI on push to main and locally with `node scripts/build-registry.mjs`.
// Validates first and refuses to build on error.
//
// Outputs:
//   registry.json              — LEGACY full dump (every entry, full payload) for
//                                 older clients. Committed to the repo. Deprecated:
//                                 it grows linearly with the catalog and is the file
//                                 we're moving clients off of.
//   public/                    — static site published to Cloudflare Pages.
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

function main() {
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

  // Full entries: the manifest plus, for bundled entries, the list of vendored
  // files. This is the legacy registry.json shape and the base for each detail file.
  const fullEntries = manifests
    .map(({ folder, manifest }) => {
      const entry = { ...manifest };
      if (manifest.source && manifest.source.type === "bundled") {
        entry.files = collectFiles(folder);
      }
      return { folder, entry };
    })
    .sort((a, b) => a.entry.id.localeCompare(b.entry.id));

  // --- Legacy: registry.json (committed, full dump) ----------------------
  writeJson(join(ROOT, "registry.json"), {
    version: 1,
    generatedAt,
    entries: fullEntries.map((e) => e.entry),
  });

  // --- New: split index + content-addressed detail into public/ ----------
  rmSync(PUBLIC_DIR, { recursive: true, force: true });

  const index = [];
  for (const { folder, entry } of fullEntries) {
    const updatedAt = gitLastModified(folder) || generatedAt;
    // Hash the stable content — the manifest plus the *contents* of any vendored
    // files — but not generatedAt. So an unchanged entry keeps the same hash
    // run-to-run, which is what makes its detail file cacheable forever.
    const filesContentHash = entry.files ? vendoredContentHash(folder, entry.files) : null;
    const hash = contentHash({ entry, filesContentHash });
    const detail = { ...entry, hash, updatedAt };

    // Content-addressed: the client builds this URL from the index entry's id+hash.
    writeJson(join(PUBLIC_DIR, "detail", `${entry.id}.${hash}.json`), detail);

    // Vendored content, fetched at install time from /entries/<id>/<file>.
    for (const rel of entry.files || []) {
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
  console.log(`✓ built registry.json + public/ (${n} entr${n === 1 ? "y" : "ies"}, indexHash ${indexHash})`);
}

main();
