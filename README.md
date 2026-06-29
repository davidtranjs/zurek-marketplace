# Zurek Marketplace

A curated, community-maintained catalog of **MCP servers**, **skills**, **agents**, and **bundles** that you can install into your AI coding tools (Claude Code, Cursor, Codex, and more) straight from the [Zurek](https://github.com/davidtranjs/zurek) macOS app.

In Zurek: **+ → Browse Marketplace**, review what an entry does, pick which tool(s) to install it into, and go.

## How it works

- Every entry lives in its own folder under [`entries/`](entries/) with a `manifest.json`.
- A GitHub Action regenerates [`registry.json`](registry.json) — a single index — whenever entries change.
- The Zurek app fetches `registry.json` from:

  ```
  https://raw.githubusercontent.com/davidtranjs/zurek-marketplace/main/registry.json
  ```

- Skill/agent content is either **vendored** in the entry folder or **referenced** from an upstream GitHub repo; the app downloads it at install time. MCP servers carry their full config (command/args/env or URL) in the manifest, so you can review exactly what will run before installing.

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
