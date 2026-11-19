# ArtifactBoard Plugin for Claude Code

Author interactive, single-file HTML slide decks in Claude Code and publish them straight from disk to your personal [ArtifactBoard](https://artifactboard.com) without copying HTML bytes through LLM tool arguments.

## What's Included

- **Authoring Skill (`skills/artifactboard/SKILL.md`):** Guides Claude Code to generate responsive, self-contained 16:9 HTML slide decks (`<= 5 MB`) compatible with ArtifactBoard's origin-isolated presentation sandbox (`sandbox="allow-scripts"`, `connect-src 'none'`) and Deck Spec v2 metadata.
- **Backfill Skill (`skills/backfill-artifactboard/SKILL.md`):** Audits outdated or legacy decks via `artifactboard_list_decks`, streams cloud decks straight to disk with `artifactboard_download_deck`, and non-destructively upgrades them to Deck Spec v2 without losing content or styling.
- **Troubleshooting Skill (`skills/troubleshoot-artifactboard/SKILL.md`):** Diagnoses installation, MCP discovery, Node.js `>= 22`, sign-in/multi-account, export quota, CSP/sandbox, sharing, and Presentation Mode issues.
- **Update Skill (`skills/update-artifactboard/SKILL.md`):** Checks installed vs. latest plugin versions and pulls updates safely from trusted origins while preserving credentials, unrelated MCP servers, and sibling skills.
- **Local MCP Server (`mcp/server.mjs`):** Zero-dependency Node.js stdio Model Context Protocol server that handles browser-approved device login and streams `.html` decks directly from disk.
- **Synced Presentation Mode:** Press `F` to present fullscreen or `P` to open the two-tab Speaker Console with live interactive hover/click mirroring, speaker notes, timer, virtual laser (`L`), and blackout (`B`).

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

Both installers download the verified plugin archive into `~/.config/artifactboard/claude-plugin`, install the skills into `~/.claude/skills/` (`artifactboard`, `backfill-artifactboard`, `troubleshoot-artifactboard`, and `update-artifactboard`), and register the user-scoped `artifactboard` stdio MCP server while preserving unrelated files and settings.

## Quick Start

1. Ask Claude Code: *"Check my ArtifactBoard login status."*
2. If you aren't signed in yet, Claude Code starts `artifactboard_login`, displays your device confirmation code in chat first, and then opens `https://artifactboard.com/cli/authorize?code=...` in your browser so you can match the code and approve access in one click.
3. Ask Claude Code: *"Create an interactive HTML slide deck for this repo and export it to ArtifactBoard."*
4. Claude Code writes the `.html` deck locally, streams it from disk via `artifactboard_export_deck`, and returns your personal board and share links.

## MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `artifactboard_status` | Check local sign-in status, `@handle`, email, board URL, and storage quota |
| `artifactboard_login` | Run browser-approved device-code sign-in and save credentials locally (`0600`) |
| `artifactboard_export_deck` | Stream a local `.html` file (`<= 5 MB`) straight from disk to your board (with optional `expected_handle` guard) |
| `artifactboard_download_deck` | Stream a published deck from your board straight to a local `.html` file on disk (zero LLM token copy) |
| `artifactboard_list_decks` | List decks on your board with visibility, sizes, share URLs, and Deck Spec v2 status (`up_to_date` / `needs_backfill`) |
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

## Backfilling Legacy Decks

If you have older decks on your board missing Presenter Mode mirroring, hardware pointer key forwarding (`B`, `.`, `F5`, `Escape`), or Deck Spec v2 metadata, ask Claude Code *"Audit and backfill my outdated ArtifactBoard decks"* or invoke `/backfill-artifactboard`. Claude Code checks `artifactboard_list_decks`, streams any cloud-only decks straight to disk with `artifactboard_download_deck`, applies only the missing upgrades without changing your slide content or theme, and re-exports preserving each deck's original `slug`, `title`, and `visibility`.

## Updating

To check for or pull the latest plugin release without affecting your saved credentials or unrelated configs, ask Claude Code *"Update my ArtifactBoard plugin"* or invoke `/update-artifactboard`.

## Troubleshooting

If setup, sign-in, deck export, sandbox rendering, or Presentation Mode hits an issue, ask Claude Code *"Troubleshoot my ArtifactBoard setup"* or invoke `/troubleshoot-artifactboard` to run the read-only diagnostic checklist without exposing tokens.

## Uninstall

- **Marketplace install:** Run `/plugin uninstall artifactboard@artifactboard` inside Claude Code.
- **Direct installer:** Run `claude mcp remove --scope user artifactboard`, remove `~/.config/artifactboard/claude-plugin`, `~/.claude/skills/artifactboard`, `~/.claude/skills/backfill-artifactboard`, `~/.claude/skills/troubleshoot-artifactboard`, and `~/.claude/skills/update-artifactboard`, and (optionally) remove `~/.config/artifactboard/credentials.json`.

## Author & License

Maintained by [@redchilipaste](https://github.com/redchilipaste). Licensed under the [MIT License](LICENSE).
