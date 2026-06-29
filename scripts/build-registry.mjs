// Regenerates registry.json from every entries/<id>/manifest.json. The Zurek
// app fetches this single file. Run by CI on push to main and locally with
// `node scripts/build-registry.mjs`. Validates first and refuses to build on error.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadAll, validateManifest, collectFiles } from "./lib.mjs";

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

  const entries = manifests
    .map(({ folder, manifest }) => {
      const entry = { ...manifest };
      // Record vendored files so the app can download each via a raw URL
      // without hitting the GitHub contents API.
      if (manifest.source && manifest.source.type === "bundled") {
        entry.files = collectFiles(folder);
      }
      return entry;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const registry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };

  const out = join(ROOT, "registry.json");
  writeFileSync(out, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`✓ wrote registry.json with ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

main();
