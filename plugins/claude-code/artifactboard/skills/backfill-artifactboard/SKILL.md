---
name: backfill-artifactboard
description: Audit outdated or legacy ArtifactBoard HTML slide decks and non-destructively upgrade them to Deck Spec v2 (sandbox/CSP safety, Presenter Console mirroring, hardware pointer keys, and hidden deck metadata) without losing slide content or styling.
---

# Backfill ArtifactBoard Decks (Deck Spec v2)

Use this skill when auditing existing local or published ArtifactBoard decks and upgrading legacy decks (`needs_backfill`) to **Deck Spec v2** across **Google Antigravity** or **Claude Code** while preserving all slide copy, layout, CSS theming, and interactive widgets.

## 0. Safety & Version Skew

- **Check plugin version skew first:** If MCP tools are missing or outdated (`v1.0.0` lacks `backfill-artifactboard` and `artifactboard_download_deck`; `v1.1.0` lacks `artifactboard_validate_deck`), stop and run `/update-artifactboard` (and verify Node.js `>= 22` plus `artifactboard_login`) before continuing.
- **Preserve author intent:** Never delete slides, rewrite copy, alter visual branding/CSS themes, remove SVGs, or drop custom interactive widgets. Upgrade behavior additively.
- **One deck at a time & confirm batches:** If multiple cloud decks are flagged `needs_backfill`, list their `slug`, `title`, and `missingFeatures`, and confirm target slugs with the user before upgrading multiple decks.
- **Zero raw HTML in chat & zero secrets:** Always download, validate, and edit decks on local disk via `artifactboard_download_deck`, `artifactboard_validate_deck`, and `artifactboard_export_deck`. Never paste full HTML into chat, and never read, log, or paste raw `ab_live_...` tokens or `~/.config/artifactboard/credentials.json` secrets.

## 1. Confirm Account & Discover Outdated Decks

1. Call `artifactboard_status()` to confirm the active `@handle`, `email`, and target board before touching cloud decks.
2. **Cloud decks:** Call `artifactboard_list_decks()` and inspect `outdatedCount`, per-deck `deckSpec.status` (`'needs_backfill'` vs `'up_to_date'`), `detectedFeatures`, `missingFeatures`, and `sha256`.
3. **Local `.html` files:** If the user provides a local `.html` path, inspect it directly on disk against the Deck Spec v2 checklist below.

## 2. Verify Local Source, Backup, & Download Cloud Decks

- **Existing local `.html` files:** Before editing an existing local `.html` file in place, compute its local SHA-256 and verify it matches `artifactboard_list_decks().decks[].sha256` for the target slug (so you do not overwrite newer/different content). Advise the user to create a backup first if the file lives outside Git.
- **Cloud-only or mismatched decks:** Call `artifactboard_download_deck({ slug, output_path, expected_handle })` (pass `overwrite: true` only after confirming with the user if `output_path` exists).
- Never copy raw HTML through chat or tool arguments; keep all edits on disk and process **one deck at a time** through steps 3 and 4.

## 3. Non-Destructive Deck Spec v2 Upgrade Checklist

**Audit existing behavior first:** Pre-v2 cloud decks may report `missingFeatures` even when bridge or clicker listeners already exist in `<script>`. Read and audit existing `message` and `keydown` listeners before editing, and **NEVER bolt duplicate listeners onto `<script>`**—extend the existing handlers in place.

### 3.1 Preserve Content, Layout, & Assets
- Keep all slide copy, structure, custom CSS variables/themes, inline `<svg>` artwork, and interactive controls intact.

### 3.2 Sandbox & CSP Safety (`sandbox="allow-scripts"`, `connect-src 'none'`)
- Keep the deck self-contained in one UTF-8 `.html` file `<= 5,242,880` bytes (5 MB) with zero external script/stylesheet URLs, zero relative asset paths, and zero `fetch()` / `XMLHttpRequest` / `WebSocket` calls.
- Guard **every** `localStorage`, `sessionStorage`, `document.cookie`, `history.pushState`, and `history.replaceState` call (plus any opaque-origin `location.hash` or Web Storage usage) inside `try { ... } catch {}` because sandboxed opaque origins throw `SecurityError`.
- Skip `document.startViewTransition()` whenever framed (`window.self !== window.top`) or when `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is true.

### 3.3 Presenter Console & Interactive Mirroring (`presenter-bridge-v1`)
Only emit `postMessage` when `window.parent && window.parent !== window`, and strictly validate incoming messages with `event.source === window.parent && event.data?.source === 'artifactboard-host'`.

| Direction | Message / Field | Contract & Edge Cases |
| :--- | :--- | :--- |
| **Deck → Host** | `state` (`source: 'artifactboard-deck', version: 1`) | `{ type: 'state', origin, index, total, title, notes, nextTitle, nextNotes, slides: [{ index, title }] }`. **0-based `index` (`0..total - 1`)**—convert 1-based decks! |
| **Deck → Host** | `origin` enum | `'init' \| 'user' \| 'host'`. Responding to host commands with `'host'` prevents feedback loops. |
| **Host → Deck** | `cmd` (`source: 'artifactboard-host', version: 1`) | `{ type: 'cmd', action: 'next' \| 'prev' \| 'first' \| 'last' \| 'goto' \| 'requestState', index? }`. |
| **Deck → Host** | `shortcut` | `{ type: 'shortcut', key }` for `'f'`, `'f5'`, `'p'`, `'b'` (including `.`), `'l'`, `'escape'`. |
| **Bidirectional** | `interact` | `{ type: 'interact', kind: 'hover' \| 'leave' \| 'click' \| 'input' \| 'pointer', target, x?, y?, value?, checked? }`. `pointer` `x`/`y` are normalized `0..1` viewport ratios, `requestAnimationFrame`-throttled. |

- **Slide DOM & selector edge cases:**
  - Adapt active-slide lookup and `resolveTarget` (`{ id?, slideIndex, path }` via `document.getElementById` + `activeSlide.children` traversal—never `querySelector` with untrusted strings) to the deck's **existing** slide selector. Never rename existing slide classes to `.slide.is-active`.
  - Ensure each slide has `data-title="..."` and `data-notes="..."`. Add empty `data-notes=""` when no speaker notes exist—never invent or fabricate notes, and never put secrets/tokens in `data-notes` on `public` or `unlisted` decks.
  - Pair `:hover` rules with `:is(:hover, [data-ab-hover="true"])`. Wrap replayed DOM actions in `isReplaying = true` inside `try { ... } finally { isReplaying = false; }`.
  - For `<svg>` targets (which may lack `.click()`), fall back to `dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`; for JS-driven hover widgets, also dispatch synthetic `pointerenter` / `pointerleave` / `pointerover` as needed.

### 3.4 Hardware Pointer Keys (`pointer-keys-v1`)
In the deck's existing `keydown` handler when framed (`window.parent !== window`):
- **Plain `F5` (no modifier keys):** **Always** call `event.preventDefault()`—even inside inputs or open modals so hardware clickers never reload the iframe—and only forward `{ type: 'shortcut', key: 'f5' }` when focus is outside inputs (`INPUT`/`TEXTAREA`/`SELECT`/`contentEditable`) and no modal is open.
- **`B` and `.`:** Ignore inputs/modals and forward as `{ type: 'shortcut', key: 'b' }` (blackout toggle).
- **`Escape`:** Dismiss any open in-deck modal/overlay/popover and `return`/`break` **before** forwarding `{ type: 'shortcut', key: 'escape' }` (forward only when no in-deck modal/overlay/popover was open).

### 3.5 Metadata Placement & Mandatory Validation Gate
Only **after** verifying sandbox safety, `presenter-bridge-v1`, and `pointer-keys-v1` are genuinely implemented, **insert these tags at the TOP of `<head>` (before `<style>`), within the first 64 KB of the file** for universal compatibility:

```html
<meta name="artifactboard:deck-spec" content="2">
<meta name="artifactboard:features" content="presenter-bridge-v1,pointer-keys-v1">
```

- Never add `<meta name="artifactboard:deck-spec" content="2">` or feature tokens unless the corresponding behavior is actually present.
- **Mandatory validation gate:** Run `artifactboard_validate_deck({ file_path })` AFTER editing and confirm `valid === true` and `readyForDeckSpecV2 === true` (zero errors) before re-exporting.

## 4. Re-Export & Verify `up_to_date`

1. Re-export the upgraded local `.html` file while preserving original metadata:
   - Call `artifactboard_export_deck({ file_path, slug, title, visibility, expected_handle })` with the original `slug`, `title`, `visibility` (unless asked to change them), and `expected_handle`.
2. Confirm the export response reports `deckSpec.status === 'up_to_date'` (and zero `missingFeatures`).
3. Summarize the upgrades applied, confirm all original slides/widgets were preserved, and share the updated `presentUrl` / `boardUrl`.
