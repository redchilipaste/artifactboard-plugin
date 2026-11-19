# ArtifactBoard Plugin for Claude Code

Author interactive, single-file HTML slide decks in Claude Code and publish them straight from disk to your personal [ArtifactBoard](https://artifactboard.com) without copying HTML bytes through LLM tool arguments.

## What's Included

- **Skill (`skills/artifactboard/SKILL.md`):** Guides Claude Code to generate responsive, self-contained 16:9 HTML slide decks (`<= 5 MB`) compatible with ArtifactBoard's origin-isolated presentation sandbox (`sandbox="allow-scripts"`, `connect-src 'none'`).
- **Local MCP Server (`mcp/server.mjs`):** Zero-dependency Node.js stdio Model Context Protocol server that handles browser-approved device login and streams `.html` decks directly from disk.

## Requirements

- **Node.js `>= 22`** (no `npm install` or third-party dependencies required)
- An [ArtifactBoard](https://artifactboard.com/signup) account (sign in with Google and claim your `@handle`)

## Installation

### Option 1: Native Claude Code Marketplace (Recommended)

Inside Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add redchilipaste/artifactboard-plugin
/plugin install artifactboard@artifactboard
```

### Option 2: Ask Claude Code (Direct Installer Prompt)

Paste this prompt directly into Claude Code:

> Install the ArtifactBoard plugin for Claude Code by running "irm https://artifactboard.com/install/claude.ps1 | iex" (Windows PowerShell) or "curl -fsSL https://artifactboard.com/install/claude.sh | sh" (macOS/Linux) for my OS, then verify Node.js 22+ and confirm the ArtifactBoard MCP server is registered for Claude Code.

### Option 3: Hosted Direct Installer (Terminal)

**Windows (PowerShell):**
```powershell
irm https://artifactboard.com/install/claude.ps1 | iex
```

**macOS / Linux (`sh`):**
```sh
curl -fsSL https://artifactboard.com/install/claude.sh | sh
```

Both installers download the verified plugin archive into `~/.config/artifactboard/claude-plugin`, install the skill into `~/.claude/skills/artifactboard/SKILL.md`, and register the user-scoped `artifactboard` stdio MCP server while preserving unrelated files and settings.

## Quick Start

1. Ask Claude Code: *"Check my ArtifactBoard login status."*
2. If you aren't signed in yet, Claude Code calls `artifactboard_login`, which opens `https://artifactboard.com/cli/authorize?code=...` in your browser for one-click approval.
3. Ask Claude Code: *"Create an interactive HTML slide deck for this repo and export it to ArtifactBoard."*
4. Claude Code writes the `.html` deck locally, streams it from disk via `artifactboard_export_deck`, and returns your personal board and share links.

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

- **Marketplace install:** Run `/plugin uninstall artifactboard@artifactboard` inside Claude Code.
- **Direct installer:** Run `claude mcp remove --scope user artifactboard`, remove `~/.config/artifactboard/claude-plugin` and `~/.claude/skills/artifactboard`, and (optionally) remove `~/.config/artifactboard/credentials.json`.

## Author & License

Maintained by [@redchilipaste](https://github.com/redchilipaste). Licensed under the [MIT License](LICENSE).
