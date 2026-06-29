# Contributing to the Zurek Marketplace

Thanks for adding to the catalog! Every entry is a folder under `entries/` containing a `manifest.json`. You never edit `registry.json` — it's generated from the manifests on merge.

## Quick start

1. Create `entries/<your-entry-id>/manifest.json`. The folder name **must** equal the manifest `id` (lowercase kebab-case).
2. Fill in the fields for your entry type (see below).
3. Validate locally — no dependencies needed:
   ```sh
   node scripts/validate.mjs
   ```
4. Open a PR. CI validates your entry; once merged, `registry.json` is rebuilt automatically.

## Common fields (all types)

| Field             | Required | Notes                                                 |
| ----------------- | -------- | ----------------------------------------------------- |
| `id`              | ✓        | Lowercase kebab-case; must match the folder name.     |
| `type`            | ✓        | `mcp` \| `skill` \| `agent` \| `bundle`.              |
| `name`            | ✓        | Display name.                                         |
| `description`     | ✓        | One-line summary (shown in the list).                 |
| `author`          | ✓        | Person or org.                                        |
| `longDescription` |          | Markdown shown in the review pane.                    |
| `homepage`        |          | Project/source URL.                                   |
| `tags`            |          | Array of strings.                                     |
| `version`         |          | Free-form version string.                             |
| `license`         |          | e.g. `MIT`.                                           |

## `mcp` — an MCP server

```json
{
  "id": "context7",
  "type": "mcp",
  "name": "Context7",
  "description": "Up-to-date library docs pulled into context.",
  "author": "Upstash",
  "homepage": "https://github.com/upstash/context7",
  "tags": ["docs"],
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"],
    "env": [
      { "key": "API_KEY", "description": "Optional API key", "required": false, "secret": true }
    ]
  }
}
```

- `transport`: `"stdio"` (needs `command`, optional `args`) or `"http"` (needs `url`, optional `serverType`).
- `env`: list of variables the user fills at install. Each has `key`, optional `description`, `required` (default `true`), `secret` (default `false`, renders as a password field), and `default`.

## `skill` and `agent` — content

Provide content one of two ways via `source`:

**Vendored** (files live in this repo, easy to review and pin):

```json
{
  "id": "code-reviewer",
  "type": "agent",
  "name": "Code Reviewer",
  "description": "Reviews diffs for bugs and clarity.",
  "author": "Zurek",
  "source": { "type": "bundled" },
  "install": { "fileName": "code-reviewer.md" }
}
```
Put the content next to the manifest (`entries/code-reviewer/code-reviewer.md`, or `SKILL.md` + `references/…` for a skill).

**Upstream GitHub reference** (the app downloads from the source repo at install):

```json
{
  "id": "monorepo-management",
  "type": "skill",
  "name": "Monorepo Management",
  "description": "Patterns for working in a monorepo.",
  "author": "wshobson",
  "source": {
    "type": "github",
    "repo": "wshobson/agents",
    "ref": "main",
    "path": "plugins/developer-essentials/skills/monorepo-management",
    "isDirectory": true
  },
  "install": { "dirName": "monorepo-management" }
}
```

- `install.dirName` (skills) — the directory name created under `…/skills/`.
- `install.fileName` (agents) — the file name written under `…/agents/`.
- `source.isDirectory` — set `true` for multi-file skills so the whole directory is downloaded.

## `bundle` — a pack

References other entries by id; installing the bundle installs each.

```json
{
  "id": "essentials-pack",
  "type": "bundle",
  "name": "Essentials Pack",
  "description": "A starter set: docs MCP + a code-review agent.",
  "author": "Zurek",
  "items": [{ "id": "context7" }, { "id": "code-reviewer" }]
}
```

## Schema

A JSON Schema is available at [`schema/manifest.schema.json`](schema/manifest.schema.json) for editor autocomplete. `node scripts/validate.mjs` is the source of truth for what CI enforces.
