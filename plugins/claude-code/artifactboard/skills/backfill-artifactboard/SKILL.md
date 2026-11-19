---
name: backfill-artifactboard
description: Audit outdated or legacy ArtifactBoard HTML slide decks and non-destructively upgrade them to Deck Spec v2 (sandbox/CSP safety, Presenter Console mirroring, hardware pointer keys, and hidden deck metadata) without losing slide content or styling.
---

# Backfill ArtifactBoard Decks (Deck Spec v2)

Use this skill when auditing existing local or published ArtifactBoard decks and upgrading legacy decks (`needs_backfill`) to **Deck Spec v2** across **Google Antigravity** or **Claude Code** while preserving all slide copy, layout, CSS theming, and interactive widgets.

## 0. Safety & Non-Destructive Rules

- **Preserve author intent:** Never delete slides, rewrite copy, alter visual branding/CSS themes, remove SVGs, or drop custom interactive widgets. Upgrade behavior additively.
- **One deck at a time & confirm batches:** If multiple cloud decks are flagged `needs_backfill`, list their `slug`, `title`, and `missingFeatures`, and confirm target slugs with the user before upgrading multiple decks.
- **Zero raw HTML in chat & zero secrets:** Always download and edit decks on local disk via `artifactboard_download_deck` and `artifactboard_export_deck`. Never paste full HTML into chat, and never read, log, or paste raw `ab_live_...` tokens or `~/.config/artifactboard/credentials.json` secrets.
- **Install or sign-in errors:** If MCP tools are missing or authentication fails, stop and verify your Node.js `>= 22` installation and `artifactboard_login` sign-in before retrying.

## 1. Confirm Account & Discover Outdated Decks

1. Call `artifactboard_status()` to confirm the active `@handle`, `email`, and target board before touching cloud decks.
2. **Cloud decks:** Call `artifactboard_list_decks()` and inspect:
   - `outdatedCount` for the board summary.
   - Per-deck `deckSpec.status` (`'needs_backfill'` vs `'up_to_date'`), `detectedFeatures`, and `missingFeatures`.
3. **Local `.html` files:** If the user provides a local `.html` file path, inspect it directly on disk against the Deck Spec v2 checklist below.

## 2. Download Cloud Decks Straight to Disk

For any cloud deck that does not already have a verified local `.html` source file:

- Call `artifactboard_download_deck({ slug, output_path, expected_handle })` (pass `overwrite: true` only after confirming with the user if `output_path` already exists).
- Never copy raw HTML through chat or tool arguments; keep all edits on the downloaded local `.html` file.
- Process **one deck at a time** through steps 3 and 4 before moving to the next confirmed slug.

## 3. Non-Destructive Deck Spec v2 Upgrade Checklist

Apply only the missing upgrades to the local `.html` file, verifying each requirement carefully:

1. **Preserve content, layout, and assets:**
   - Keep all slide copy, structure, custom CSS variables/themes, inline `<svg>` artwork, and interactive controls intact.
2. **Sandbox & CSP safety (`sandbox="allow-scripts"`, `connect-src 'none'`):**
   - Keep the entire deck self-contained in a single UTF-8 `.html` file strictly `<= 5,242,880` bytes (5 MB) with zero external script/stylesheet URLs, zero relative asset paths, and zero `fetch()` / `XMLHttpRequest` / `WebSocket` calls.
   - Guard **every** `localStorage`, `sessionStorage`, or `document.cookie` access in `try { ... } catch {}` (opaque sandboxed origins throw `SecurityError`).
   - Guard `document.startViewTransition()` so it is skipped whenever framed (`window.self !== window.top`) or when `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is true.
3. **Presenter Console & Interactive Mirroring (`presenter-bridge-v1`):**
   - Ensure each `.slide` element has `data-title="..."` and `data-notes="..."` attributes (fill sensible titles from slide headings if missing; **never** place secrets, tokens, or private credentials inside `data-notes` on `public` or `unlisted` decks).
   - Pair interactive `:hover` CSS rules (such as cards, flow nodes, choice buttons, and tabs) with `:is(:hover, [data-ab-hover="true"])` so mirrored Speaker Console hovers animate on the stage.
   - Add or verify the framed `postMessage` bridge (`source: 'artifactboard-deck', version: 1` ↔ `source: 'artifactboard-host', version: 1`):
     - Only emit `postMessage` when `window.parent && window.parent !== window`.
     - Strictly validate incoming messages with `event.source === window.parent && event.data?.source === 'artifactboard-host'`.
     - Emit `state` (`{ type: 'state', origin, index, total, title, notes, nextTitle, nextNotes, slides }`), `shortcut`, and `interact` (`hover`, `leave`, `click`, `input`, `pointer`).
     - Resolve mirrored targets safely inside `.slide.is-active` using `{ id?, slideIndex, path }` (`document.getElementById` + `activeSlide.children` traversal—never `querySelector` with untrusted strings) and wrap replayed DOM actions in `isReplaying = true` inside `try { ... } finally { isReplaying = false; }`.
4. **Hardware Pointer Compatibility (`pointer-keys-v1`):**
   - In the deck's `keydown` handler (ignoring inputs/`textarea`/`select`), when framed (`window.parent !== window`):
     - Forward `B` and `.` as `{ type: 'shortcut', key: 'b' }` (blackout toggle).
     - Forward plain `F5` (no modifier keys) with `event.preventDefault()` as `{ type: 'shortcut', key: 'f5' }` so hardware clickers do not reload the tab.
     - Forward `Escape` as `{ type: 'shortcut', key: 'escape' }` only when no in-deck modal/dialog/overlay is currently open.
5. **Hidden Deck Metadata (`<head>`) — stamp ONLY after verification:**
   - Only **after** verifying that both `presenter-bridge-v1` and `pointer-keys-v1` (plus sandbox safety) are genuinely implemented and working in the file, add or update these tags inside `<head>`:

```html
<meta name="artifactboard:deck-spec" content="2">
<meta name="artifactboard:features" content="presenter-bridge-v1,pointer-keys-v1">
```

   - Never add `<meta name="artifactboard:deck-spec" content="2">` or feature tokens unless the corresponding behavior is actually present in the deck.

## 4. Re-Export & Verify `up_to_date`

1. Re-export the upgraded local `.html` file while preserving the deck's original metadata:
   - Call `artifactboard_export_deck({ file_path, slug, title, visibility, expected_handle })`.
   - Always pass the original `slug`, `title`, and `visibility` (unless the user explicitly asked to change them) plus `expected_handle`.
2. Confirm the export response reports `deckSpec.status === 'up_to_date'` (and zero `missingFeatures`).
3. Summarize the exact upgrades applied, confirm all original slides/widgets were preserved, and share the updated `presentUrl` / `boardUrl`.
