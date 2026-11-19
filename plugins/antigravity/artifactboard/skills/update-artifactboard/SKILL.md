---
name: update-artifactboard
description: Check for and safely pull the latest ArtifactBoard plugin update across Google Antigravity and Claude Code, verifying installed versions, preserving credentials and unrelated configs, and confirming reload.
---

# Update ArtifactBoard

Use this skill whenever the user wants to check for or install the latest **ArtifactBoard** plugin update in **Google Antigravity** or **Claude Code**.

## 0. Safety & Trusted-Origin Rules

- **Trusted origins only:** Pull updates exclusively from `https://artifactboard.com`, the official GitHub repository `https://github.com/redchilipaste/artifactboard-plugin` (`raw.githubusercontent.com/redchilipaste/artifactboard-plugin/main/...`), or an explicit user-configured `ARTIFACTBOARD_ORIGIN` (`https://`, `http://localhost`, or `http://127.0.0.1`). Strip any trailing `/` so `<origin>` is strictly a bare `scheme://host[:port]` with no path, whitespace, or shell metacharacters, and confirm with the user before executing installers from any non-`https://artifactboard.com` origin. Never download or execute scripts from untrusted third-party URLs.
- **Zero-secret & non-destructive guarantee:** Updates preserve `~/.config/artifactboard/credentials.json` sign-in, unrelated MCP servers, and unrelated skills. Never read, log, or paste raw `ab_live_...` tokens, `ARTIFACTBOARD_TOKEN` values, or raw contents of `credentials.json` or `pending-login.json`.
- **Check-only vs. apply:** If the user only asks whether an update is available, stop after Section 1 and ask for confirmation before running an installer.

## 1. Check Installed Version, Agent, Origin & Node.js (Read-Only)

1. **Check Node.js runtime:** Run `node -v` and confirm `Node.js >= 22`.
2. **Inspect installed manifest & origin** (never print `ARTIFACTBOARD_TOKEN`):
   - **Google Antigravity:** Read `"version"` in `~/.gemini/config/plugins/artifactboard/plugin.json` and inspect `~/.gemini/config/mcp_config.json` for `"mcpServers.artifactboard"` (note any custom `env.ARTIFACTBOARD_ORIGIN`).
   - **Claude Code (Marketplace install):** Run `/plugin list` and check the installed `artifactboard@artifactboard` entry.
   - **Claude Code (Direct install):** Read `"version"` in `~/.config/artifactboard/claude-plugin/.claude-plugin/plugin.json`, list `~/.claude/skills/`, and check `claude mcp list` or `"mcpServers.artifactboard"` in `~/.claude.json` (note any custom `env.ARTIFACTBOARD_ORIGIN`).
3. **Optional published version check (production origin):**
   - Read `"version"` from `https://raw.githubusercontent.com/redchilipaste/artifactboard-plugin/main/.claude-plugin/marketplace.json` (or `plugins/antigravity/artifactboard/plugin.json`).
   - Note that hosted installers on `<origin>` always pull the live bundle served directly by `<origin>`, even while GitHub sync is in progress or when offline proxies block GitHub.

## 2. Pull & Apply Latest Update (Match OS & Install Method)

Use the user's configured `<origin>` (default: `https://artifactboard.com`).

### Google Antigravity

- **Hosted Direct Updater (Recommended — idempotent & repairs global `mcp_config.json`):**
  - **Windows (PowerShell):**
    ```powershell
    irm <origin>/install.ps1 | iex
    ```
  - **macOS / Linux (`sh`):**
    ```sh
    curl -fsSL <origin>/install.sh | sh
    ```
- **Native Antigravity CLI (`agy`, when on `PATH`):**
  ```sh
  agy plugin install https://github.com/redchilipaste/artifactboard-plugin/plugins/antigravity/artifactboard
  ```
  Verify `"artifactboard"` is still registered in global `~/.gemini/config/mcp_config.json` afterwards (Antigravity skips plugin-local `mcp_config.json`); if missing, run the hosted updater above.

### Claude Code

- **Native Marketplace Install (Recommended for production `https://artifactboard.com`):**
  Run inside Claude Code:
  ```text
  /plugin marketplace update artifactboard
  /plugin update artifactboard@artifactboard
  ```
  (Or re-run `/plugin install artifactboard@artifactboard`), then run `/reload-plugins`.
- **Hosted Direct Updater (custom/staging origins or when `/plugin` commands are unavailable):**
  - **Windows (PowerShell):**
    ```powershell
    irm <origin>/install/claude.ps1 | iex
    ```
  - **macOS / Linux (`sh`):**
    ```sh
    curl -fsSL <origin>/install/claude.sh | sh
    ```
  Refreshes `~/.config/artifactboard/claude-plugin`, updates all bundled skills under `~/.claude/skills/` (`artifactboard`, `backfill-artifactboard`, `troubleshoot-artifactboard`, `update-artifactboard`) while preserving unrelated sibling skills, and re-registers the user-scoped `artifactboard` MCP server.

> **Local repository developers:** Never overwrite an active local clone with hosted installers. Use `npm run export:plugins` or point `<origin>` at a local server (`http://127.0.0.1:<port>`) when testing unreleased builds.

## 3. Verify Update, Reload & Optional Follow-Ups

1. **Report version transition:** Re-read the installed `plugin.json` `"version"` (or `/plugin list` for Claude Code marketplace installs) and report `<old> → <new>` (or `<version> (already up to date / refreshed)`).
2. **Verify 4-skill & MCP registration:**
   - **Antigravity:** Confirm `~/.gemini/config/plugins/artifactboard/skills/` contains `artifactboard`, `backfill-artifactboard`, `troubleshoot-artifactboard`, and `update-artifactboard`, and that `"artifactboard"` is present in `~/.gemini/config/mcp_config.json`.
   - **Claude Code:** Confirm `~/.claude/skills/` (for direct installs) or `/plugin list` (for marketplace installs) reflects `artifactboard`, `backfill-artifactboard`, `troubleshoot-artifactboard`, and `update-artifactboard`, and that `artifactboard` is registered in `claude mcp list` (or `~/.claude.json` for direct installs).
3. **Required reload:** Instruct the user to **restart Antigravity and open a new chat** (or run `/reload-plugins` / restart Claude Code) so the active session loads the updated `mcp/server.mjs` and skills.
4. **Optional post-reload checks:**
   - Call `artifactboard_status()` to confirm saved sign-in remained intact.
   - Call `artifactboard_list_decks()`; if older decks are now flagged `needs_backfill`, offer to run `backfill-artifactboard`.
   - If updating or reloading fails, hand off to the companion `troubleshoot-artifactboard` skill.
