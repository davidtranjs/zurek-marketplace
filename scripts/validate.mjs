// Validates every entry manifest. Run by CI on pull requests and locally with
// `node scripts/validate.mjs`. Exits non-zero if anything is wrong.

import { loadAll, validateManifest } from "./lib.mjs";

function main() {
  let data;
  try {
    data = loadAll();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const errors = [];
  for (const { folder, manifest } of data.manifests) {
    errors.push(...validateManifest(manifest, folder, data.allIds));
  }

  if (errors.length) {
    console.error(`✗ ${errors.length} problem(s) found:`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }

  const count = data.manifests.length;
  console.log(`✓ ${count} entr${count === 1 ? "y" : "ies"} valid`);
}

main();
