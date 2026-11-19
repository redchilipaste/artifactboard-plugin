# ArtifactBoard Plugins (Antigravity & Claude Code)

This repository distributes the official ArtifactBoard plugins for both **Google Antigravity** (`plugins/antigravity/artifactboard/`) and **Claude Code** (`plugins/claude-code/artifactboard/`).

Both plugins share the exact same zero-dependency Node.js `>= 22` stdio MCP server, `skills/artifactboard/SKILL.md` authoring guide, and `~/.config/artifactboard/credentials.json` login, allowing you to author interactive, single-file HTML slide decks and publish them straight from disk to your personal [ArtifactBoard](https://artifactboard.com) without copying HTML bytes through LLM tool arguments.

## What's Included

- **Antigravity Plugin (`plugins/antigravity/artifactboard/`):** Native Antigravity manifest (`plugin.json`), MCP configuration (`mcp_config.json`), shared `SKILL.md`, shared `mcp/server.mjs`, and `assets/logo.svg`.
- **Claude Code Plugin (`plugins/claude-code/artifactboard/` & `.claude-plugin/marketplace.json`):** Native Claude Code marketplace manifest, `.claude-plugin/plugin.json`, `.mcp.json`, shared `SKILL.md`, shared `mcp/server.mjs`, and `assets/logo.svg`.
- **Skill (`skills/artifactboard/SKILL.md`):** Guides Antigravity and Claude Code to generate responsive, self-contained 16:9 HTML slide decks (`<= 5 MB`) compatible with ArtifactBoard's origin-isolated presentation sandbox (`sandbox="allow-scripts"`, `connect-src 'none'`).
- **Local MCP Server (`mcp/server.mjs`):** Zero-dependency Node.js stdio Model Context Protocol server that handles browser-approved device login and streams `.html` decks directly from disk.
- **Synced Presentation Mode:** Press `F` to present fullscreen or `P` to open the two-tab Speaker Console with live interactive hover/click mirroring, speaker notes, timer, virtual laser (`L`), and blackout (`B`).

## Requirements

- **Node.js `>= 22`** (no `npm install` or third-party dependencies required)
- An [ArtifactBoard](https://artifactboard.com/signup) account (sign in with Google and claim your `@handle`)

## Installation

### Google Antigravity

#### Option 1: Ask Antigravity (No Terminal)

Paste this prompt directly into Antigravity chat:

> Install the ArtifactBoard plugin for Antigravity by running "irm https://artifactboard.com/install.ps1 | iex" (Windows PowerShell) or "curl -fsSL https://artifactboard.com/install.sh | sh" (macOS/Linux) for my OS, then verify Node.js 22+ and confirm ~/.gemini/config/plugins/artifactboard/plugin.json and the "artifactboard" entry in ~/.gemini/config/mcp_config.json are installed.

#### Option 2: Native Antigravity CLI

Install directly from this GitHub repository *(note: `agy` CLI may not be on `PATH` by default on standard Windows desktop installs; use Option 1 or Option 3 if unavailable)*:

```sh
agy plugin install https://github.com/redchilipaste/artifactboard-plugin/plugins/antigravity/artifactboard
```

#### Option 3: Hosted Direct Installer (Terminal)

**Windows (PowerShell):**
```powershell
irm https://artifactboard.com/install.ps1 | iex
```

**macOS / Linux (`sh`):**
```sh
curl -fsSL https://artifactboard.com/install.sh | sh
```

Both installers unpack the verified plugin into `~/.gemini/config/plugins/artifactboard` and register `"artifactboard"` in `~/.gemini/config/mcp_config.json` (preserving unrelated files and existing MCP servers). Restart Antigravity and open a new chat so it loads the skill and MCP tools.

---

### Claude Code

#### Option 1: Native Claude Code Marketplace (Recommended)

Inside Claude Code, add the marketplace and install the plugin:

```text
/plugin marketplace add redchilipaste/artifactboard-plugin
/plugin install artifactboard@artifactboard
```

#### Option 2: Ask Claude Code (Direct Installer Prompt)

Paste this prompt directly into Claude Code:

> Install the ArtifactBoard plugin for Claude Code using "/plugin marketplace add redchilipaste/artifactboard-plugin" and "/plugin install artifactboard@artifactboard" (or if plugin commands are unavailable, run "irm https://artifactboard.com/install/claude.ps1 | iex" on Windows PowerShell or "curl -fsSL https://artifactboard.com/install/claude.sh | sh" on macOS/Linux), then verify Node.js 22+ and check artifactboard_status.

#### Option 3: Hosted Direct Installer (Terminal)

**Windows (PowerShell):**
```powershell
irm https://artifactboard.com/install/claude.ps1 | iex
```

**macOS / Linux (`sh`):**
```sh
curl -fsSL https://artifactboard.com/install/claude.sh | sh
```

Both direct installers unpack the verified plugin archive into `~/.config/artifactboard/claude-plugin`, install the skill into `~/.claude/skills/artifactboard/SKILL.md`, and register the user-scoped `artifactboard` stdio MCP server while preserving unrelated files and settings.

## Quick Start

1. Ask Antigravity or Claude Code: *"Check my ArtifactBoard login status."*
2. If you aren't signed in yet, your agent calls `artifactboard_login`, which opens `https://artifactboard.com/cli/authorize?code=...` in your browser for one-click approval. Credentials are saved once at `~/.config/artifactboard/credentials.json` and shared across both agents.
3. Ask Antigravity or Claude Code: *"Create an interactive HTML slide deck for this repo and export it to ArtifactBoard."*
4. Your agent writes the `.html` deck locally, streams it from disk via `artifactboard_export_deck`, and returns your personal board and share links.

## MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `artifactboard_status` | Check local sign-in status, `@handle`, email, board URL, and storage quota |
| `artifactboard_login` | Run browser-approved device-code sign-in and save credentials locally (`0600`) |
| `artifactboard_export_deck` | Stream a local `.html` file (`<= 5 MB`) straight from disk to your board (with optional `expected_handle` guard) |
| `artifactboard_list_decks` | List decks on your board with visibility, sizes, and share URLs |
| `artifactboard_update_deck` | Update title, change visibility (`private`/`unlisted`/`public`), or rotate an unlisted key |
| `artifactboard_delete_deck` | Permanently delete a deck from your board |
| `artifactboard_logout` | Sign out on this machine, revoking the saved CLI token and removing local credentials |

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

- **Antigravity:** Run `agy plugin uninstall artifactboard` (if installed via CLI), or remove `~/.gemini/config/plugins/artifactboard` and remove the `"artifactboard"` entry from `~/.gemini/config/mcp_config.json`, then restart Antigravity.
- **Claude Code (Marketplace install):** Run `/plugin uninstall artifactboard@artifactboard` inside Claude Code.
- **Claude Code (Direct installer):** Run `claude mcp remove --scope user artifactboard`, then remove `~/.config/artifactboard/claude-plugin` and `~/.claude/skills/artifactboard`.
- **Shared credentials (optional):** Remove `~/.config/artifactboard/credentials.json` to clear saved sign-in credentials for both agents.

## Author & License

Maintained by [@redchilipaste](https://github.com/redchilipaste). Licensed under the [MIT License](LICENSE).
