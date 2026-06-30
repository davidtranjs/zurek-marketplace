# Marketplace data architecture

This document explains how the catalog is stored, built, and served, and why it
is shaped this way. It also defines the **Phase 2 API contract** so client teams
(Zurek macOS + web) can build against a stable shape today.

## The problem we're solving

The original design concatenated every `entries/<id>/manifest.json` into a single
`registry.json` carrying each entry's **full** payload (`longDescription`, full
`mcp` config, `env`, `source`, `install`, …). Clients downloaded and parsed the
whole file on every launch.

That does not scale. Real-world directories are already large and growing fast:

| Directory | Entries (mid-2026) |
| --- | --- |
| Glama | ~37,000 MCP servers |
| PulseMCP | ~12k–18k MCP servers |
| Smithery | ~7,000 MCP servers |
| Claude Code Plugins | 12,500+ MCP servers |

At ~0.8 KB per full manifest, 37k entries is **~30 MB raw / ~6 MB gzipped** — far
too much to fetch on every app launch. The list view only needs ~6 fields per
entry, so ~80% of those bytes are detail nobody is looking at yet.

## Two classes of entry

The right storage depends on where an entry comes from:

1. **Curated / vendored** — PR-reviewed, content vendored in this repo (e.g.
   `code-reviewer`). Small N. **Git is the source of truth.** Lives in `entries/`.
2. **Aggregated / mirrored** — pulled from upstream registries (Glama, PulseMCP,
   the official MCP Registry). Tens of thousands. These should **not** become Git
   manifests; they belong in a data store synced incrementally (Phase 2).

Phase 1 covers class 1 and shrinks what every client must download. Phase 2 adds
a searchable API for class 2.

---

## Phase 1 — split index + lazy detail (implemented)

`node scripts/build-registry.mjs` validates every manifest, then emits:

```
public/                    Build output (gitignored; published to Cloudflare Pages by CI).
├── meta.json              { version, generatedAt, count, indexHash }  — tiny, always fresh.
├── index.json             Slim list: list/search/filter fields + per-entry hash. No heavy detail.
├── registry.json          LEGACY full dump, for older clients. Deprecated — being phased out.
├── detail/
│   └── <id>.<hash>.json   Full per-entry detail. Content-addressed → cache forever.
├── entries/
│   └── <id>/...           Vendored content files (downloaded at install time).
└── _headers               Cloudflare cache rules (immutable detail vs revalidate).
```

Nothing here is committed to git — it's all regenerated on every deploy. CI builds
`public/` and pushes it straight to Cloudflare Pages; there is no bot commit back to
`main` (that's what previously caused non-fast-forward push failures).

### Shapes

**`meta.json`**
```json
{ "version": 1, "generatedAt": "2026-06-30T03:41:19.916Z", "count": 4, "indexHash": "dc30461b191524bb" }
```

**`index.json`** — array of slim entries:
```json
{
  "id": "context7", "type": "mcp", "name": "Context7",
  "description": "Up-to-date code docs…", "author": "Upstash",
  "tags": ["docs", "reference", "context"], "version": "1.0.0",
  "license": "MIT", "homepage": "https://github.com/upstash/context7",
  "hash": "975d6d0e28f2095e", "updatedAt": "2026-06-29T16:40:10+07:00"
}
```

**`detail/<id>.<hash>.json`** — the full manifest plus `hash` and `updatedAt`
(and `files` for vendored entries). This is what the review pane needs. The
client builds the URL from the index entry's `id` and `hash`.

- `hash` is a content hash of the entry's stable payload — manifest **plus the
  contents of any vendored files**, but not `generatedAt`. So an unchanged entry
  keeps the same hash forever, and editing a vendored file changes it. Because
  the hash is in the **filename**, each version has a unique URL and detail can be
  served `immutable` (cache forever) without ever going stale.
- `indexHash` is the hash of the whole slim index.
- `updatedAt` is the last git commit time touching the entry folder.

### Client fetch flow

```
1. GET meta.json                      (a few hundred bytes — always)
2. if meta.indexHash == cached         → render list from local cache; done.
   else GET index.json                 → render list/search/filter; cache it.
3. on entry click:
   GET detail/<id>.<hash>.json          → using id+hash from the index entry;
                                          cache forever (the URL is unique per version).
   For vendored content, fetch entries/<id>/<file> as listed in `files`.
```

Result: a 37k-entry catalog costs one tiny `meta.json` per launch, an `index.json`
only when something changed, and detail only for entries the user actually opens.
If a content-addressed detail URL ever 404s (entry changed since the index was
loaded), re-fetch `meta.json` + `index.json` and retry with the new hash.

### Serving — Cloudflare Pages

`public/` is a self-contained static site deployed to **Cloudflare Pages**: free,
unlimited bandwidth, global CDN, brotli, and — crucially — per-path cache headers
via the generated `public/_headers`:

| Path | `Cache-Control` | Why |
| --- | --- | --- |
| `detail/*` | `max-age=31536000, immutable` | content-addressed URL; never changes |
| `meta.json` | `max-age=0, must-revalidate` | must always reflect the latest deploy |
| `index.json` | `max-age=0, must-revalidate` | revalidated cheaply via ETag (304) |
| `entries/*` | `max-age=0, must-revalidate` | vendored content; revalidate via ETag |

It is served at **`https://marketplace-data.zurek.app`**, so clients fetch:

```
https://marketplace-data.zurek.app/meta.json
https://marketplace-data.zurek.app/index.json
https://marketplace-data.zurek.app/detail/<id>.<hash>.json
https://marketplace-data.zurek.app/entries/<id>/<file>
https://marketplace-data.zurek.app/registry.json          (legacy, deprecated)
```

**Deploy** runs in `.github/workflows/build-registry.yml` via `cloudflare/wrangler-action`
(`pages deploy public`). One-time setup:

1. Create the Pages project once: `wrangler pages project create zurek-marketplace`
   (or via the Cloudflare dashboard → Workers & Pages → Create → Pages).
2. Add two GitHub repo secrets:
   - `CLOUDFLARE_API_TOKEN` — a token with the **Cloudflare Pages: Edit** permission.
   - `CLOUDFLARE_ACCOUNT_ID` — your account id.
3. Attach the custom domain: Pages project → **Custom domains** → "Set up a domain" →
   `marketplace-data.zurek.app`. Since `zurek.app` is already a Cloudflare zone in the same
   account, Cloudflare creates the proxied CNAME (`marketplace-data` → `zurek-marketplace.pages.dev`)
   and provisions TLS automatically — no manual DNS record needed.
4. Point the clients (macOS app + web) at `https://marketplace-data.zurek.app`.

`marketplace.zurek.app` (without `-data`) is intentionally left free for a future
purpose (e.g. a web frontend); this data API stays on the `-data` subdomain.

When Phase 2 arrives, the searchable API can run as a Cloudflare Worker on the same
account (e.g. routed at `marketplace-data.zurek.app/v1/*`), optionally in front of these
same static files.

---

## Phase 2 — searchable API over a data store (when to build)

**Trigger:** `index.json` exceeds ~1 MB gzipped (~10–20k entries), or you start
aggregating upstream catalogs. Below that, Phase 1 is enough — don't build this early.

This mirrors the **official MCP Registry**, which solves the same problem with
PostgreSQL + cursor pagination + an `updated_since` delta filter, not a flat file.

Git stays the source of truth for **curated** entries; CI syncs them into the
store. **Aggregated** entries sync directly from upstream `updated_since` APIs and
never touch Git. The store can be a search engine (Meilisearch / Typesense /
Algolia) or Cloudflare Workers + D1/KV.

### Proposed API contract

```
GET /v1/entries?type=&q=&tags=&limit=&cursor=&updated_since=
  → 200 {
      "entries": [ <slim entry, same shape as index.json> ],
      "meta": { "count": 12345, "nextCursor": "<opaque|null>" }
    }

GET /v1/entries/{id}
  → 200 <full detail, same shape as public/detail/<id>.<hash>.json>
  → 404 if unknown

GET /v1/meta
  → 200 { "version": 1, "count": 12345, "generatedAt": "…", "indexHash": "…" }
```

- `limit` default 50, max 100. Pagination is **cursor-based** (opaque `nextCursor`),
  not offset — stable under inserts.
- `q` full-text over name/description/tags; `type` and `tags` filter; combinable.
- `updated_since` (RFC 3339) returns only entries changed since a timestamp, for
  incremental client sync and upstream mirroring.

Because the slim and detail shapes are **identical** to Phase 1's `index.json` and
`entries/<id>.json`, a client written for Phase 1 swaps its data source to these
endpoints with no model changes. Nothing in Phase 1 is throwaway.
