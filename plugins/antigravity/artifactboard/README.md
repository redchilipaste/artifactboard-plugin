# ArtifactBoard Plugin for Antigravity

Author interactive, single-file HTML slide decks in Antigravity and publish them straight from disk to your personal [ArtifactBoard](https://artifactboard.com) without copying HTML bytes through LLM tool arguments.

## What's Included

- **Skill (`skills/artifactboard/SKILL.md`):** Guides Antigravity to generate responsive, self-contained 16:9 HTML slide decks (`<= 5 MB`) compatible with ArtifactBoard's origin-isolated presentation sandbox (`sandbox="allow-scripts"`, `connect-src 'none'`).
- **Local MCP Server (`mcp/server.mjs`):** Zero-dependency Node.js stdio Model Context Protocol server that handles browser-approved device login and streams `.html` decks directly from disk.

## Requirements

- **Node.js `>= 22`** (no `npm install` or third-party dependencies required)
- An [ArtifactBoard](https://artifactboard.com/signup) account (sign in with Google and claim your `@handle`)

## Installation

### Option 1: Ask Antigravity (Recommended — No Terminal)

Paste this prompt directly into Antigravity chat:

> Install the ArtifactBoard plugin for Antigravity by running "irm https://artifactboard.com/install.ps1 | iex" (Windows PowerShell) or "curl -fsSL https://artifactboard.com/install.sh | sh" (macOS/Linux) for my OS, then verify Node.js 22+ and confirm ~/.gemini/config/plugins/artifactboard/plugin.json and the "artifactboard" entry in ~/.gemini/config/mcp_config.json are installed.

### Option 2: Run Manually in Terminal

**Windows (PowerShell):**
```powershell
irm https://artifactboard.com/install.ps1 | iex
```

**macOS / Linux (`sh`):**
```sh
curl -fsSL https://artifactboard.com/install.sh | sh
```

Both installers download the verified plugin archive, unpack it into `~/.gemini/config/plugins/artifactboard`, normalize native paths in `mcp_config.json`, and register the `artifactboard` stdio MCP server in `~/.gemini/config/mcp_config.json` (preserving unrelated files and existing MCP servers). Restart Antigravity and open a new chat so it loads the skill and MCP tools.

### Option 3: Native Antigravity CLI (GitHub)

*(Note: `agy` CLI may not be on `PATH` by default on standard Windows desktop installs; use Option 1 or Option 2 if `agy` is unavailable.)*

```sh
agy plugin install https://github.com/redchilipaste/artifactboard-plugin/plugins/antigravity/artifactboard
```

### Local Directory Install (Antigravity CLI)

From this plugin directory (where `plugin.json` lives):
```sh
agy plugin validate --strict .
agy plugin install .
```

## Quick Start

1. Ask Antigravity: *"Check my ArtifactBoard login status."*
2. If you aren't signed in yet, Antigravity calls `artifactboard_login`, which opens `https://artifactboard.com/cli/authorize?code=...` in your browser for one-click approval.
3. Ask Antigravity: *"Create an interactive HTML slide deck for this repo and export it to ArtifactBoard."*
4. Antigravity writes the `.html` deck locally, streams it from disk via `artifactboard_export_deck`, and returns your personal board and share links.

## MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `artifactboard_status` | Check local sign-in status, `@handle`, board URL, and storage quota |
| `artifactboard_login` | Run browser-approved device-code sign-in and save credentials locally (`0600`) |
| `artifactboard_export_deck` | Stream a local `.html` file (`<= 5 MB`) straight from disk to your board |
| `artifactboard_list_decks` | List decks on your board with visibility, sizes, and share URLs |
| `artifactboard_update_deck` | Update title, change visibility (`private`/`unlisted`/`public`), or rotate an unlisted key |
| `artifactboard_delete_deck` | Permanently delete a deck from your board |

## Configuration (Optional Environment Variables)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `ARTIFACTBOARD_ORIGIN` | `https://artifactboard.com` | Target ArtifactBoard origin (must use `https://`, or `http://127.0.0.1` / `localhost` for local dev) |
| `ARTIFACTBOARD_CONFIG_PATH` | `~/.config/artifactboard/credentials.json` | Custom path for saved CLI credentials |
| `ARTIFACTBOARD_TOKEN` | *(unset)* | Optional bearer token override for automation (credentials file is used otherwise) |

## Security & Privacy

- Credentials are stored locally at `~/.config/artifactboard/credentials.json` with `0600` file permissions on POSIX systems and are strictly scoped to their saved origin (`ARTIFACTBOARD_ORIGIN`).
- Raw `ab_live_...` tokens are never printed by MCP tool responses and are stored on ArtifactBoard only as SHA-256 hashes.
- Read the [Privacy Policy](https://artifactboard.com/privacy) and [Terms of Service](https://artifactboard.com/terms).

## Uninstall

Remove `~/.gemini/config/plugins/artifactboard`, remove the `"artifactboard"` entry from `~/.gemini/config/mcp_config.json`, and (optionally) remove `~/.config/artifactboard/credentials.json`, then restart Antigravity.

## Author & License

Maintained by [@redchilipaste](https://github.com/redchilipaste). Licensed under the [MIT License](LICENSE).
