---
name: troubleshoot-artifactboard
description: Diagnose and fix ArtifactBoard plugin installation, MCP server discovery, Node.js runtime, device sign-in, multi-account or origin mismatch, deck export or quota errors, sandbox/CSP rendering failures, sharing visibility, and two-tab Presentation Mode across Google Antigravity and Claude Code.
---

# Troubleshoot ArtifactBoard

Use this skill whenever ArtifactBoard setup, MCP tools, authentication, deck publishing, sandbox rendering, sharing links, or Presentation Mode fails in **Google Antigravity** or **Claude Code**.

## 0. Safety & Read-Only Rules

- **Inspect read-only first:** Check versions, paths, `artifactboard_status()`, and `.html` deck source before modifying any files, credentials, or published decks.
- **Confirm destructive actions:** Ask the user before revoking tokens (`artifactboard_logout`), deleting decks (`artifactboard_delete_deck`), rotating unlisted keys, or overwriting configuration files.
- **Zero-secret rule:** Never read, print, log, or paste raw `ab_live_...` tokens, `Authorization: Bearer` headers, session cookies (`__Host-ab_session`), or raw contents of `~/.config/artifactboard/credentials.json` or `pending-login.json`. Check only file existence/permissions (`0600`) or call `artifactboard_status()` (if inspecting local credential metadata, extract only `origin`, `handle`, and `savedAt` — never `token`).

## Quick Triage

| Symptom | Jump To |
| :--- | :--- |
| MCP tools missing, `node` error, or plugin not loaded | [Section 1](#1-installation--mcp-discovery) |
| `401`, `ACCOUNT_MISMATCH`, `ORIGIN_MISMATCH`, login stuck | [Section 2](#2-sign-in-multi-account--origin-mismatch) |
| Export or download rejected (`FILE_NOT_FOUND`, `FILE_EXISTS`, `QUOTA_EXCEEDED`) | [Section 3](#3-deck-export-download--quota-errors) |
| Blank slide, `SecurityError`, blocked assets, `403` on `decks.artifactboard.com` | [Section 4](#4-sandbox--csp-rendering-failures) |
| `404` / private deck, `403 SANDBOX_ONLY`, broken unlisted `?key=` URL | [Section 5](#5-sharing-visibility--links) |
| Presenter popup blocked, console disconnected, no hover mirror | [Section 6](#6-two-tab-presentation-mode--speaker-console) |

## 1. Installation & MCP Discovery

1. **Verify Node.js `>= 22`:** Run `node -v`. If the shell is `>= 22` but the agent fails to launch `mcp/server.mjs`, the GUI/IDE `PATH` is likely resolving an older Node binary (`nvm`/`fnm`/system path). Point `mcp_config.json` or `.mcp.json` to the absolute Node 22+ binary path.
2. **Google Antigravity:**
   - Verify `~/.gemini/config/plugins/artifactboard/` contains `plugin.json`, `mcp/server.mjs`, `skills/artifactboard/SKILL.md`, `skills/backfill-artifactboard/SKILL.md`, `skills/troubleshoot-artifactboard/SKILL.md`, and `skills/update-artifactboard/SKILL.md`.
   - Verify global `~/.gemini/config/mcp_config.json` contains `"mcpServers.artifactboard"` pointing to resolved `node` + `~/.gemini/config/plugins/artifactboard/mcp/server.mjs` (Antigravity skips plugin-local `mcp_config.json`). Re-running `/install.ps1` or `/install.sh` repairs this non-destructively (or use the companion `update-artifactboard` skill if the installed plugin version is outdated or missing new skills/tools).
   - Restart Antigravity and open a **new chat** to reload skills and MCP tools.
3. **Claude Code:**
   - **Marketplace install:** Verify `/plugin marketplace add redchilipaste/artifactboard-plugin` and `/plugin install artifactboard@artifactboard`.
   - **Direct install:** Verify `~/.config/artifactboard/claude-plugin/mcp/server.mjs`, `~/.claude/skills/artifactboard/SKILL.md`, `~/.claude/skills/backfill-artifactboard/SKILL.md`, `~/.claude/skills/troubleshoot-artifactboard/SKILL.md`, `~/.claude/skills/update-artifactboard/SKILL.md`, and `claude mcp list` (or user-scoped `artifactboard` in `~/.claude.json`).
   - If the installed plugin version is outdated or missing new skills/tools, use the companion `update-artifactboard` skill to pull the latest release.
   - Run `/reload-plugins` or restart Claude Code.
4. **Environment overrides:** Check if `ARTIFACTBOARD_ORIGIN`, `ARTIFACTBOARD_CONFIG_PATH`, `ARTIFACTBOARD_TOKEN` (overrides saved credentials until unset), or `ARTIFACTBOARD_NO_BROWSER=1` are set in the shell or MCP `env` block.

## 2. Sign-In, Multi-Account & Origin Mismatch

Start by calling `artifactboard_status()` (returns `handle`, `email`, `boardUrl`, `quota`).

- **`401` / `UNAUTHORIZED` / `UNAUTHENTICATED`:** The token expired or was revoked (for example, under `/{handle}/boards` → **Connected Devices**, or replaced by a newer sign-in). Run the two-step `artifactboard_login()` flow (call with no args first to display `userCode` + `authorizeUrl` in chat, then `artifactboard_login({ resume_pending: true, open_browser: true })`).
- **Wrong account / `409 ACCOUNT_MISMATCH`:** Pass `expected_handle` on `artifactboard_export_deck` or `artifactboard_download_deck` to prevent acting on the wrong board. To switch accounts, run `artifactboard_logout()` + `artifactboard_login()`, or click **Switch account** on `/cli/authorize?code=...` (preserves `?code=`).
- **`ORIGIN_MISMATCH`:** Saved credentials `origin` differs from `ARTIFACTBOARD_ORIGIN` (default `https://artifactboard.com`; only `https://`, `http://localhost`, and `http://127.0.0.1` are allowed). Unset/align `ARTIFACTBOARD_ORIGIN`, use a separate `ARTIFACTBOARD_CONFIG_PATH` per environment, or logout + login.
- **`LOGIN_EXPIRED`, `NO_PENDING_LOGIN`, `SESSION_EXPIRED`, `SESSION_ALREADY_USED`, or browser did not open:** When `ARTIFACTBOARD_NO_BROWSER=1`, headless, or using `open_browser: false`, open `authorizeUrl` manually in a browser; if expired or already consumed, restart `artifactboard_login()`.
- **`EMAIL_NOT_VERIFIED` / `HANDLE_REQUIRED`:** Sign in at `/signup` with a verified Google account email and claim your `@handle` first.
- **`LOGOUT_UNLINK_FAILED` / `NETWORK_ERROR`:** Run `artifactboard_logout({ revoke_remote: false })` to remove local credentials, then revoke the device remotely in `/{handle}/boards` → **Connected Devices** once back online.

## 3. Deck Export, Download & Quota Errors

- **File rules:** Never pass raw HTML inline; always write to disk and pass `file_path` (or `output_path` for `artifactboard_download_deck`).
  - `FILE_NOT_FOUND`: check that `file_path` exists and points to a regular file.
  - `INVALID_FILE_TYPE` / `INVALID_OUTPUT_PATH`: filename must end in `.html` or `.htm`, and `output_path` cannot be a symlink, directory, or non-regular file.
  - `FILE_EXISTS` (on `artifactboard_download_deck`): destination already exists — ask the user before passing `overwrite: true`, or pick a new `output_path`.
  - `INVALID_FILE_SIZE` / `PAYLOAD_TOO_LARGE`: file must be non-empty and `<= 5,242,880` bytes (5 MB).
  - `INVALID_HTML`: file must be valid UTF-8 HTML.
- **Input validation:**
  - `INVALID_SLUG`: lowercase `a-z`, `0-9`, and hyphens only, 1–64 chars (no leading/trailing hyphen).
  - `INVALID_TITLE`: `<= 140` characters.
  - `INVALID_VISIBILITY`: must be `private`, `unlisted`, or `public`.
  - `INVALID_EXPECTED_HANDLE` / `EMPTY_PATCH`: verify handle format and provide at least one field to `artifactboard_update_deck`.
- **`QUOTA_EXCEEDED` / `RATE_LIMITED`:** Starter quotas are **15 decks**, **5 MB/deck**, **50 MB total**, and **20 writes/hour**. Run `artifactboard_list_decks()` to inspect usage; reuse an existing `slug` to overwrite in place or ask before calling `artifactboard_delete_deck`.

## 4. Sandbox & CSP Rendering Failures

Published decks render inside `<iframe sandbox="allow-scripts">` on `decks.artifactboard.com` with strict CSP:
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.

Scan the user's local `.html` file for these common causes:
1. **Unguarded Web Storage / cookies:** `localStorage`, `sessionStorage`, or `document.cookie` throws `SecurityError` in an opaque origin — wrap optional reads/writes in `try { ... } catch {}` or remove them.
2. **External URLs or relative paths:** `<script src>`, `<link href>`, external fonts, or `./`/`../` paths are blocked — inline all CSS, JS, and SVG, or embed media as `data:` URIs.
3. **Network calls:** `fetch()`, `XMLHttpRequest`, and `WebSocket` are blocked by `connect-src 'none'` — bundle static data directly into the HTML.
4. **Unguarded View Transitions:** Calling `document.startViewTransition()` inside an iframe can trigger cross-origin OOPIF crashes — skip when `window.self !== window.top` or `prefers-reduced-motion: reduce`.
5. **`403 Forbidden` or expired render ticket on `decks.artifactboard.com`:** `decks.artifactboard.com` requires `Sec-Fetch-Dest: iframe` (opening it directly in a browser tab returns `403 Forbidden`) and render tickets (`?rt=`) expire after `120s` TTL. Always open `https://artifactboard.com/{handle}/board/{slug}` (or reload the host page).

## 5. Sharing, Visibility & Links

- New exports default to `private` (owner-only). Use `artifactboard_list_decks()` to inspect current visibility and `artifactboard_update_deck({ slug, visibility })` to switch to `public` (shown on your podium shelf) or `unlisted` (requires `?key=...`).
- **`403 SANDBOX_ONLY`:** The server is currently in `sandbox_only` mode, which restricts `starter` accounts to `private` decks only (`unlisted` and `public` publishing are disabled until the environment re-enables open sharing).
- Passing `rotate_unlisted_key: true` invalidates all prior `?key=` URLs immediately — share the newly returned `unlistedUrl`.
- **Privacy note:** `public` and `unlisted` HTML — including `data-notes` speaker notes — is readable in source by anyone with access. Never store secrets in slide notes.

## 6. Two-Tab Presentation Mode & Speaker Console

- **Popup blocked on `P`:** Allow popups for `artifactboard.com` in the browser, or click the revealed fallback link (`?view=presenter`, which preserves `?key=` for unlisted decks).
- **Console stays disconnected / no sync:** Sync uses `BroadcastChannel` (`ab-present:<deckKey>:<session>` or `ab-present:<deckKey>`). Both tabs must be in the **same browser profile** (not normal + Incognito), **same origin**, and **same deck**. Wait ~3s for the heartbeat or reload the console tab.
- **Legacy notice after ~2.5s ("no speaker notes" / basic sync) or `needs_backfill` status:** The deck is missing Deck Spec v2 metadata or the Deck Bridge v1 (`source: 'artifactboard-deck', version: 1`) `postMessage` handshake / `data-title` & `data-notes` attributes on `.slide` elements. Use the companion `backfill-artifactboard` skill to upgrade it non-destructively.
- **Hover/click mirroring not appearing on stage:** Verify CSS pairs `:hover` with `:is(:hover, [data-ab-hover="true"])`, interactive targets live inside `.slide.is-active`, incoming messages strictly check `event.source === window.parent && event.data?.source === 'artifactboard-host'`, and replayed events are guarded by `isReplaying = true` in `try/finally`.

## 7. Clean Escalation Report

If the issue persists, share this sanitized summary (never include tokens, headers, or cookies):

```text
- OS & Agent: <Windows/macOS/Linux> · <Antigravity / Claude Code>
- Node.js: <node -v output>
- Install Path: <~/.gemini/config/plugins/artifactboard | ~/.config/artifactboard/claude-plugin | marketplace>
- Origin: <ARTIFACTBOARD_ORIGIN or https://artifactboard.com>
- Action & Sanitized Error: <tool or URL> → <HTTP status / error code, e.g. ORIGIN_MISMATCH>
- Credentials check: <present/missing, 0600 verified, zero secrets attached>
```
