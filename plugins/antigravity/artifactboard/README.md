# ArtifactBoard Plugin for Antigravity

Author interactive, single-file HTML slide decks in Antigravity and publish them straight from disk to your personal [ArtifactBoard](https://artifactboard.com) without copying HTML bytes through LLM tool arguments.

## What's Included

- **Authoring Skill (`skills/artifactboard/SKILL.md`):** Guides Antigravity to generate responsive, self-contained 16:9 HTML slide decks (`<= 5 MB`) compatible with ArtifactBoard's origin-isolated presentation sandbox (`sandbox="allow-scripts"`, `connect-src 'none'`) and Deck Spec v2 metadata.
- **Backfill Skill (`skills/backfill-artifactboard/SKILL.md`):** Audits outdated or legacy decks via `artifactboard_list_decks`, streams cloud decks straight to disk with `artifactboard_download_deck`, and non-destructively upgrades them to Deck Spec v2 without losing content or styling.
- **Troubleshooting Skill (`skills/troubleshoot-artifactboard/SKILL.md`):** Diagnoses installation, MCP discovery, Node.js `>= 22`, sign-in/multi-account, export quota, CSP/sandbox, sharing, and Presentation Mode issues.
- **Update Skill (`skills/update-artifactboard/SKILL.md`):** Checks installed vs. latest plugin versions and pulls updates safely from trusted origins while preserving credentials, unrelated MCP servers, and sibling skills.
- **Local MCP Server (`mcp/server.mjs`):** Zero-dependency Node.js stdio Model Context Protocol server that handles browser-approved device login and streams `.html` decks directly from disk.
- **Synced Presentation Mode:** Press `F` to present fullscreen or `P` to open the two-tab Speaker Console with live interactive hover/click mirroring, speaker notes, timer, virtual laser (`L`), and blackout (`B`).

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
2. If you aren't signed in yet, Antigravity starts `artifactboard_login`, displays your device confirmation code in chat first, and then opens `https://artifactboard.com/cli/authorize?code=...` in your browser so you can match the code and approve access in one click.
3. Ask Antigravity: *"Create an interactive HTML slide deck for this repo and export it to ArtifactBoard."*
4. Antigravity writes the `.html` deck locally, streams it from disk via `artifactboard_export_deck`, and returns your personal board and share links.

## MCP Tools

| Tool | Purpose |
| :--- | :--- |
| `artifactboard_status` | Check local sign-in status, `@handle`, email, board URL, and storage quota |
| `artifactboard_login` | Run browser-approved device-code sign-in and save credentials locally (`0600`) |
| `artifactboard_validate_deck` | Validate a local `.html` file against Deck Spec v2, sandbox/CSP safety, and bridge/pointer-key checks before export |
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

If you have older decks on your board missing Presenter Mode mirroring, hardware pointer key forwarding (`B`, `.`, `F5`, `Escape`), or Deck Spec v2 metadata, ask Antigravity *"Audit and backfill my outdated ArtifactBoard decks"* or invoke `/backfill-artifactboard`. Antigravity checks `artifactboard_list_decks`, streams any cloud-only decks straight to disk with `artifactboard_download_deck`, applies only the missing upgrades without changing your slide content or theme, and re-exports preserving each deck's original `slug`, `title`, and `visibility`.

## Updating

To check for or pull the latest plugin release without affecting your saved credentials or unrelated configs, ask Antigravity *"Update my ArtifactBoard plugin"* or invoke `/update-artifactboard`.

## Troubleshooting

If setup, sign-in, deck export, sandbox rendering, or Presentation Mode hits an issue, ask Antigravity *"Troubleshoot my ArtifactBoard setup"* or invoke `/troubleshoot-artifactboard` to run the read-only diagnostic checklist without exposing tokens.

## Uninstall

Remove `~/.gemini/config/plugins/artifactboard`, remove the `"artifactboard"` entry from `~/.gemini/config/mcp_config.json`, and (optionally) remove `~/.config/artifactboard/credentials.json`, then restart Antigravity.

## Author & License

Maintained by [@redchilipaste](https://github.com/redchilipaste). Licensed under the [MIT License](LICENSE).
