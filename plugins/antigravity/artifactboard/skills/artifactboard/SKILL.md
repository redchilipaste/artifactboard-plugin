---
name: artifactboard
description: Author interactive, single-file HTML slide decks and publish or manage them on ArtifactBoard. Use when building HTML presentations, talk decks, or exporting, listing, updating, or deleting decks on ArtifactBoard.
---

# ArtifactBoard Slide Deck Authoring & Publishing

Use this skill when creating self-contained `.html` slide decks or publishing and managing decks via the `artifactboard` MCP server.

## 1. Single-File HTML Deck Authoring Checklist

Every deck you generate or prepare for ArtifactBoard must satisfy all of the following:

- **Single self-contained `.html` file (`<= 5 MB` hard cap):**
  - Inline all `<style>`, `<script>`, and `<svg>` assets directly in the `.html` file.
  - Zero relative asset paths (`./image.png`, `../styles.css`) and zero external CDN scripts/stylesheets.
  - Ensure valid UTF-8 encoding and keep total file size strictly `<= 5,242,880` bytes.
- **16:9 responsive stage & accessibility:**
  - Center a 16:9 presentation stage that scales cleanly across podium projectors, laptops, and mobile viewports without overflow clipping.
  - Maintain strong accessible contrast (support light/dark color schemes cleanly), semantic headings, visible focus rings, and `aria-pressed` / `aria-selected` states on interactive controls.
- **Keyboard & presenter navigation:**
  - Bind `ArrowRight` / `PageDown` / `Space` (when focus is not on an interactive `BUTTON`, `INPUT`, `TEXTAREA`, or `SELECT`) to advance slides.
  - Bind `ArrowLeft` / `PageUp` to go back, `Home` for the first slide, and `End` for the last slide.
  - Optionally support `F` (fullscreen), `G` (slide overview dialog), and `N` or `?` (speaker notes), ignoring keystrokes inside form fields.
- **Sandbox & CSP safety (`sandbox="allow-scripts"`, `connect-src 'none'`):**
  - Published decks render inside an opaque-origin `sandbox="allow-scripts"` iframe with `connect-src 'none'`, `base-uri 'none'`, and `form-action 'none'`.
  - **NEVER call `localStorage`, `sessionStorage`, or `document.cookie` unguarded.** Accessing `localStorage` or `sessionStorage` in an opaque origin throws `SecurityError` and will crash your slide script. Either avoid Web Storage completely or wrap any optional read/write in `try { ... } catch {}`.
  - Skip `document.startViewTransition()` when framed (`window.self !== window.top`) or when `prefers-reduced-motion: reduce` is set, preventing cross-origin OOPIF renderer crashes.
  - Do not make `fetch()`, `XMLHttpRequest`, or `WebSocket` calls (blocked by `connect-src 'none'`), and do not rely on `<base>` tags or `<form>` submissions.

### Presenter Mode & Interactive Mirroring Bridge (`artifactboard-deck` v1)

To support synced two-tab Presentation Mode (Fullscreen Stage + Speaker Console with live hover/click mirroring):

- **Slide metadata & privacy:** Put `data-title="..."` and `data-notes="..."` on each `.slide` element. **Privacy reminder:** speaker notes in `public` decks live directly in the HTML source—never put secrets, tokens, or passwords in public speaker notes.
- **CSS hover mirroring:** Pair interactive `:hover` rules (`.card`, `.flow-node`, `.choice-btn`, `.tab-btn`) with `:is(:hover, [data-ab-hover="true"])` so mirrored Speaker Console hovers animate on the fullscreen stage.
- **Safe targets & loop guard:** Only target elements inside `.slide.is-active` (ignore outer toolbar buttons). Serialize targets as `{ id?, slideIndex, path }` (safe `id` + child-index `path`), resolve with `document.getElementById` + `activeSlide.children` (never `querySelector` with untrusted strings), and guard replayed DOM actions with `isReplaying = true` inside `try/finally`.
- **`postMessage` contract (only when framed, validating `event.source === window.parent && event.data?.source === 'artifactboard-host'`):**
  - **Deck → Host (`source: 'artifactboard-deck', version: 1`):**
    - `state`: `{ type: 'state', origin, index, total, title, notes, nextTitle, nextNotes, slides: [{ index, title }] }`
    - `shortcut`: `{ type: 'shortcut', key }` (`'f'`, `'p'`, `'b'`, `'l'`)
    - `interact`: `{ type: 'interact', kind: 'hover' | 'leave' | 'click' | 'input' | 'pointer', target, x?, y?, value?, checked? }`
  - **Host → Deck (`source: 'artifactboard-host', version: 1`):**
    - `cmd`: `{ type: 'cmd', action: 'next' | 'prev' | 'first' | 'last' | 'goto' | 'requestState', index? }`
    - `interact`: `{ type: 'interact', kind: 'hover' | 'leave' | 'click' | 'input', target, value?, checked? }`

```js
let isReplaying = false;
const postToHost = (payload) => { try { if (window.parent && window.parent !== window) window.parent.postMessage({ source: 'artifactboard-deck', version: 1, ...payload }, '*'); } catch {} };
const emitState = (origin = 'user') => postToHost({ type: 'state', origin, index: currentIndex, total, title: activeSlide.dataset.title || '', notes: activeSlide.dataset.notes || '', nextTitle: nextSlide?.dataset.title || '', nextNotes: nextSlide?.dataset.notes || '', slides: slides.map((s, i) => ({ index: i, title: s.dataset.title || '' })) });
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.source !== 'artifactboard-host') return;
  const msg = event.data;
  if (msg.type === 'cmd') {
    if (msg.action === 'requestState') return emitState('host');
    if (msg.action === 'goto' && Number.isInteger(msg.index)) return goToSlide(msg.index, { fromHost: true });
    if (msg.action === 'next' || msg.action === 'prev') return goToSlide(currentIndex + (msg.action === 'next' ? 1 : -1), { fromHost: true });
  } else if (msg.type === 'interact') {
    isReplaying = true;
    try {
      document.querySelectorAll('[data-ab-hover]').forEach((el) => el.removeAttribute('data-ab-hover'));
      const targetEl = resolveTarget(msg.target); // walks activeSlide.children along target.path
      if (msg.kind === 'hover' && targetEl) for (let cur = targetEl; cur && cur !== activeSlide; cur = cur.parentElement) cur.setAttribute('data-ab-hover', 'true');
      if (msg.kind === 'click' && targetEl) targetEl.click();
    } finally { isReplaying = false; }
  }
});
```

## 2. Publishing & Board Management Workflow (MCP Tools)

Always write the deck to a `.html` file on disk first, then use the 7 `artifactboard` MCP tools.

1. **Check authentication & quota:**
   - Call `artifactboard_status()`.
   - It checks `~/.config/artifactboard/credentials.json` and returns `{ handle, email, boardUrl, quota }` (or reports that login is needed).
   - Confirm the active `@handle` (and `email`) before publishing, especially if the user has multiple ArtifactBoard accounts.
2. **Sign in or switch accounts:**
   - If not authenticated, call `artifactboard_login()`.
   - This starts device authorization (`/api/v1/cli/device/start`), opens the browser to `/cli/authorize?code=...` for one-click approval, and saves the `ab_live_...` token locally with `0600` permissions.
   - To switch accounts, either call `artifactboard_logout()` followed by `artifactboard_login()`, or click **Switch account** on `/cli/authorize` in your browser during login approval.
   - **Security rule:** Never inspect, log, or paste raw `ab_live_...` tokens into chat.
3. **Export a deck directly from disk (zero LLM token copy):**
   - Call `artifactboard_export_deck({ file_path, title?, slug?, visibility?, expected_handle? })`.
   - **Always pass `file_path` pointing to the `.html` file on disk.** The MCP server streams bytes straight from disk so zero HTML tokens are copied through LLM tool arguments.
   - When the user specifies a target account (e.g., `@handle`), pass `expected_handle` so the upload is rejected if a different account is currently signed in.
   - Default `visibility` is `"private"` unless the user asks for `"unlisted"` or `"public"`.
   - Returns `presentUrl`, `unlistedUrl`, and `boardUrl`.
4. **List decks on the board:**
   - Call `artifactboard_list_decks()` to inspect slugs, titles, visibility, sizes, and share URLs.
5. **Update title, visibility, or unlisted link:**
   - Call `artifactboard_update_deck({ slug, title?, visibility?, rotate_unlisted_key? })`.
   - Ideal for switching a deck from `"private"` to `"public"` right before walking on stage, or rotating an `"unlisted"` key.
6. **Delete a deck:**
   - Call `artifactboard_delete_deck({ slug })` only when the user explicitly requests removal.
7. **Sign out:**
   - Call `artifactboard_logout({ revoke_remote? })` to revoke the saved CLI token on ArtifactBoard (default `revoke_remote: true`) and remove local credentials from `~/.config/artifactboard/credentials.json`.
