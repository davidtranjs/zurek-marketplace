# Zurek Marketplace

A curated, community-maintained catalog of **MCP servers**, **skills**, **agents**, and **bundles** that you can install into your AI coding tools (Claude Code, Cursor, Codex, and more) straight from the [Zurek](https://github.com/davidtranjs/zurek) macOS app.

In Zurek: **+ → Browse Marketplace**, review what an entry does, pick which tool(s) to install it into, and go.

## How it works

- Every entry lives in its own folder under [`entries/`](entries/) with a `manifest.json` — the source of truth.
- A GitHub Action runs `scripts/build-registry.mjs` whenever entries change. It emits a **split index** designed to scale: a tiny `meta.json`, a slim `index.json` (just the fields the list/search needs), and one content-addressed `detail/<id>.<hash>.json` file fetched lazily on click. The client downloads the small index once and pulls heavy detail only for entries the user opens. The output is published to Cloudflare Pages at **`https://marketplace-data.zurek.app`** (e.g. [`/index.json`](https://marketplace-data.zurek.app/index.json)).
- A legacy full dump is still generated for backward compatibility while clients migrate off it, served at [`/registry.json`](https://marketplace-data.zurek.app/registry.json). It does not scale and is deprecated. It's a generated artifact (not committed to the repo).
- Skill/agent content is either **vendored** in the entry folder or **referenced** from an upstream GitHub repo; the app downloads it at install time. MCP servers carry their full config (command/args/env or URL) in the manifest, so you can review exactly what will run before installing.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the output structure, the client fetch flow, and the Phase 2 searchable-API contract.

## Entry types

| Type     | What it installs                                             |
| -------- | ----------------------------------------------------------- |
| `mcp`    | An MCP server config written into the chosen tool's config. |
| `skill`  | A skill (e.g. `SKILL.md` + references) into `…/skills/`.     |
| `agent`  | A single agent file into `…/agents/`.                       |
| `bundle` | A pack that installs several other entries at once.         |

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). In short: add a folder under `entries/`, drop in a `manifest.json` (and any vendored files), run `node scripts/validate.mjs`, and open a PR. `registry.json` is generated automatically on merge — you don't edit it by hand.

## Trust & safety

Installing an MCP server lets it run commands on your machine; installing a skill or agent injects instructions into your AI tools. Entries are reviewed on PR, but **always read the command, environment variables, and content shown in the review pane before installing.** This repo curates pointers and configs; it does not vet the security of upstream packages.
