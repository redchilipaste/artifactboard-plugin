import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_ORIGIN = 'https://artifactboard.com';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);
export const CURRENT_DECK_SPEC_VERSION = 2;
export const CURRENT_REQUIRED_FEATURES = Object.freeze([
  'presenter-bridge-v1',
  'pointer-keys-v1',
]);
export const SERVER_INFO = Object.freeze({ name: 'artifactboard', version: '1.1.0' });
const SERVER_INSTRUCTIONS =
  'Author slide decks as a single self-contained .html file (<= 5 MB) with all CSS, JS, and SVG inlined and no external CDN scripts or stylesheets. Published decks render in an origin-isolated sandbox (sandbox="allow-scripts", connect-src \'none\'): guard any localStorage/sessionStorage access in try/catch, avoid fetch()/XHR/WebSocket calls, and skip document.startViewTransition() when framed (window.self !== window.top). Always write the .html deck to disk first, then call artifactboard_export_deck with file_path instead of passing HTML inline. Include Deck Spec v2 hidden <meta> tags in <head> (<meta name="artifactboard:deck-spec" content="2"> and <meta name="artifactboard:features" content="presenter-bridge-v1,pointer-keys-v1">), populate data-title/data-notes on slides, pair CSS hover rules with :is(:hover, [data-ab-hover="true"]), implement the artifactboard-deck / artifactboard-host postMessage bridge, and support hardware presenter keys (., F5, Escape). To download an existing deck directly to disk without spending LLM tokens on raw HTML, call artifactboard_download_deck; to upgrade older decks to Deck Spec v2, consult the companion backfill-artifactboard skill. When authenticating with artifactboard_login, always call it with no arguments first, show the returned userCode (and authorizeUrl fallback link) to the user in chat and let them know a browser confirmation popup is about to open, then call artifactboard_login({ resume_pending: true, open_browser: true }) to launch the browser popup and wait for approval. To pull the latest plugin update, consult the companion update-artifactboard skill; when setup, sign-in, export, sandbox rendering, or Presentation Mode fails, consult the companion troubleshoot-artifactboard skill.';

const MAX_DECK_BYTES = 5_242_880;
const MAX_TITLE_LENGTH = 140;
const HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_RESUME_OPEN_DELAY_MS = 1500;
const MAX_OPEN_DELAY_MS = 10_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const DECK_VISIBILITIES = new Set(['private', 'unlisted', 'public']);
const ALLOWED_HTML_EXTENSIONS = new Set(['.html', '.htm']);

export const TOOLS = Object.freeze([
  {
    name: 'artifactboard_status',
    description:
      'Check ArtifactBoard authentication status, handle, email, board URL, tier, and deck storage quota.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_login',
    description:
      'Authenticate with ArtifactBoard via a two-step browser device flow and save credentials locally (0600 permissions). Step 1: call with no arguments to get userCode and authorizeUrl immediately without opening the browser. Step 2: show userCode in chat and tell the user a confirmation popup is about to open, then call with { resume_pending: true, open_browser: true } to launch the browser and wait for approval.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_for_approval: {
          type: 'boolean',
          description:
            'Whether to poll until browser approval completes (default: false when starting a new login so userCode returns immediately; true when resume_pending is true).',
          default: false,
        },
        resume_pending: {
          type: 'boolean',
          description:
            'Resume a previously started pending login from disk, optionally opening the browser popup and polling for approval.',
          default: false,
        },
        open_browser: {
          type: 'boolean',
          description:
            'Open the authorization URL in the default browser (default: false on initial start; true on the first resume_pending call unless ARTIFACTBOARD_NO_BROWSER=1).',
        },
        open_delay_ms: {
          type: 'number',
          description:
            'Optional delay in milliseconds before launching the browser popup so the confirmation code is visible in chat first (clamped to 0..10000; default: 1500 when launching the OS browser on resume_pending).',
          minimum: 0,
          maximum: 10000,
        },
        poll_timeout_ms: {
          type: 'number',
          description: 'Maximum polling duration in milliseconds (clamped to 500..300000).',
          minimum: 500,
          maximum: 300000,
          default: 60000,
        },
        poll_interval_ms: {
          type: 'number',
          description: 'Polling interval in milliseconds (default: 1500).',
          minimum: 50,
          maximum: 30000,
          default: 1500,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_export_deck',
    description:
      'Upload a local standalone .html/.htm slide deck directly from disk to ArtifactBoard.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the local .html or .htm slide deck file (1 byte to 5 MB).',
          minLength: 1,
        },
        title: {
          type: 'string',
          description: 'Optional deck title (up to 140 characters). Defaults to HTML <title> or filename.',
          maxLength: 140,
        },
        slug: {
          type: 'string',
          description: 'Optional URL slug (1-64 lowercase letters, digits, or hyphens).',
          pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
        },
        visibility: {
          type: 'string',
          description: 'Deck visibility setting.',
          enum: ['private', 'unlisted', 'public'],
        },
        expected_handle: {
          type: 'string',
          description:
            'Optional target ArtifactBoard handle (with or without leading @). Fails if the active token belongs to a different account.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_list_decks',
    description:
      'List all decks on your ArtifactBoard along with share URLs, Deck Spec status, and quota summary.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_update_deck',
    description: 'Update a deck title, visibility, or rotate its unlisted share key.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Deck slug to update.',
          pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
        },
        title: {
          type: 'string',
          description: 'New deck title (up to 140 characters).',
          maxLength: 140,
        },
        visibility: {
          type: 'string',
          description: 'New deck visibility.',
          enum: ['private', 'unlisted', 'public'],
        },
        rotate_unlisted_key: {
          type: 'boolean',
          description: 'Generate a fresh unlisted share key and invalidate the previous one.',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_delete_deck',
    description: 'Delete a deck from your ArtifactBoard.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Deck slug to delete.',
          pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_logout',
    description:
      'Sign out of ArtifactBoard on this machine, revoking the saved CLI token on the server and removing local credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        revoke_remote: {
          type: 'boolean',
          description:
            'Revoke the saved token on ArtifactBoard before clearing local credentials (default: true).',
          default: true,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_download_deck',
    description:
      'Download a standalone .html/.htm deck from ArtifactBoard directly to a local file without returning raw HTML content in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Deck slug to download.',
          pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$',
        },
        output_path: {
          type: 'string',
          description: 'Local destination file path ending in .html or .htm.',
          minLength: 1,
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite an existing regular file at output_path (default: false).',
          default: false,
        },
        expected_handle: {
          type: 'string',
          description:
            'Optional target ArtifactBoard handle (with or without leading @). Fails if the active token belongs to a different account.',
        },
      },
      required: ['slug', 'output_path'],
      additionalProperties: false,
    },
  },
]);

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeSecrets(text, extraSecrets = []) {
  let result = String(text ?? '');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  result = result.replace(/\bab_live_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');
  result = result.replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]');
  return result;
}

function truncateUtf16Safe(value, maxCodeUnits) {
  const safe = String(value ?? '').toWellFormed();
  if (safe.length <= maxCodeUnits) {
    return safe;
  }
  let end = maxCodeUnits;
  const lastCode = safe.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return safe.slice(0, end);
}

function validateAndNormalizeOrigin(rawOrigin) {
  const trimmed = String(rawOrigin ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('ArtifactBoard origin must not be empty.');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ArtifactBoard origin URL: ${trimmed}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('ArtifactBoard origin must not contain credentials.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ArtifactBoard origin must be a scheme+host(+port) origin without a path or query.');
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp =
    parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (!isHttps && !isLocalHttp) {
    throw new Error(
      `Insecure ArtifactBoard origin "${parsed.origin}": only https:// or http://127.0.0.1 / http://localhost are allowed.`,
    );
  }
  return parsed.origin;
}

function slugifyCandidate(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

function slugifyTitle(title, fallbackName = '') {
  return slugifyCandidate(title) || slugifyCandidate(fallbackName) || 'untitled-deck';
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function extractHtmlTitle(htmlBuffer) {
  const headSlice = htmlBuffer.subarray(0, 32_768).toString('utf8');
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(headSlice);
  if (!match) {
    return '';
  }
  return decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
}

const DECK_SPEC_VERSION_RE = /^[1-9]\d{0,3}$/;
const FEATURE_TOKEN_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_DECK_FEATURES = 24;
const PRESENTER_BRIDGE_MARKER_RE = /['"]artifactboard-deck['"]/;
const POINTER_F5_KEY_RE = /['"][Ff]5['"]/;
const POINTER_PERIOD_KEY_RE = /['"]\.['"]/;
const POINTER_BLACKOUT_OR_B_RE = /blackout|['"][Bb]['"]/i;
const HEAD_SCAN_LIMIT_BYTES = 65_536;
const HEAD_CLOSE_TAG_RE = /<\/head(?:\s|>)/i;
const META_TAG_RE = /<meta\b([^>]{1,1024})>/gi;
const META_ATTR_RE =
  /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function sanitizeDeckSpecVersion(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 && value <= 9999 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return DECK_SPEC_VERSION_RE.test(trimmed) ? Number(trimmed) : null;
  }
  return null;
}

function sanitizeDeckFeatures(value) {
  let rawItems;
  if (typeof value === 'string') {
    rawItems = value.split(',');
  } else if (Array.isArray(value)) {
    rawItems = value;
  } else {
    return [];
  }

  const seen = new Set();
  const features = [];
  for (const item of rawItems) {
    if (typeof item !== 'string') {
      continue;
    }
    const token = item.trim().toLowerCase();
    if (!FEATURE_TOKEN_RE.test(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    features.push(token);
    if (features.length >= MAX_DECK_FEATURES) {
      break;
    }
  }
  return features;
}

function detectLegacyDeckFeatures(htmlText) {
  if (!htmlText) {
    return [];
  }
  const features = [];
  if (PRESENTER_BRIDGE_MARKER_RE.test(htmlText) && htmlText.includes('postMessage')) {
    features.push('presenter-bridge-v1');
  }
  if (
    POINTER_F5_KEY_RE.test(htmlText) &&
    POINTER_PERIOD_KEY_RE.test(htmlText) &&
    POINTER_BLACKOUT_OR_B_RE.test(htmlText)
  ) {
    features.push('pointer-keys-v1');
  }
  return features;
}

function isTagNameBoundary(char) {
  return (
    char === '>' ||
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '/'
  );
}

function findClosingTagEnd(lowerHtml, closePrefix, searchStart) {
  let idx = searchStart;
  while (idx < lowerHtml.length) {
    const found = lowerHtml.indexOf(closePrefix, idx);
    if (found === -1) {
      return lowerHtml.length;
    }
    const nextChar = lowerHtml[found + closePrefix.length];
    if (nextChar === undefined || isTagNameBoundary(nextChar)) {
      const gt = lowerHtml.indexOf('>', found + closePrefix.length);
      return gt === -1 ? lowerHtml.length : gt + 1;
    }
    idx = found + closePrefix.length;
  }
  return lowerHtml.length;
}

function toAsciiLower(text) {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

function stripCommentsScriptsAndStyles(html) {
  const lower = toAsciiLower(html);
  const parts = [];
  let pos = 0;

  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      parts.push(html.slice(pos));
      break;
    }
    if (lt > pos) {
      parts.push(html.slice(pos, lt));
    }

    if (html.startsWith('<!--', lt)) {
      const commentEnd = html.indexOf('-->', lt + 4);
      parts.push(' ');
      if (commentEnd === -1) {
        pos = html.length;
        break;
      }
      pos = commentEnd + 3;
      continue;
    }

    if (lower.startsWith('<script', lt) && isTagNameBoundary(lower[lt + 7])) {
      parts.push(' ');
      pos = findClosingTagEnd(lower, '</script', lt + 7);
      continue;
    }

    if (lower.startsWith('<style', lt) && isTagNameBoundary(lower[lt + 6])) {
      parts.push(' ');
      pos = findClosingTagEnd(lower, '</style', lt + 6);
      continue;
    }

    parts.push('<');
    pos = lt + 1;
  }

  return parts.join('');
}

function parseMetaAttributes(attrText) {
  let name = null;
  let content = null;
  META_ATTR_RE.lastIndex = 0;
  let match;
  while ((match = META_ATTR_RE.exec(attrText)) !== null) {
    const attrName = match[1].toLowerCase();
    const attrValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (attrName === 'name') {
      name = attrValue;
    } else if (attrName === 'content') {
      content = attrValue;
    }
  }
  return { name, content };
}

/**
 * Inspects standalone deck HTML for Deck Spec v2 <meta> tags and legacy feature hints.
 * Mirrors extractDeckMetadata + evaluateDeckSpecStatus without external imports.
 * @param {Buffer | string} htmlInput
 */
export function inspectDeckHtmlMetadata(htmlInput) {
  const fullText = Buffer.isBuffer(htmlInput)
    ? htmlInput.toString('utf8')
    : typeof htmlInput === 'string'
      ? htmlInput
      : '';
  const detectedFeatures = sanitizeDeckFeatures(detectLegacyDeckFeatures(fullText));

  let boundedSlice = '';
  if (Buffer.isBuffer(htmlInput)) {
    boundedSlice = htmlInput.subarray(0, HEAD_SCAN_LIMIT_BYTES).toString('utf8');
  } else if (typeof htmlInput === 'string') {
    boundedSlice = htmlInput.slice(0, HEAD_SCAN_LIMIT_BYTES);
  }

  let version = null;
  let features = [];

  if (boundedSlice) {
    const strippedSlice = stripCommentsScriptsAndStyles(boundedSlice);
    const headCloseMatch = HEAD_CLOSE_TAG_RE.exec(strippedSlice);
    const sanitizedHead = headCloseMatch
      ? strippedSlice.slice(0, headCloseMatch.index)
      : strippedSlice;

    META_TAG_RE.lastIndex = 0;
    let tagMatch;
    while ((tagMatch = META_TAG_RE.exec(sanitizedHead)) !== null) {
      const { name, content } = parseMetaAttributes(tagMatch[1]);
      if (!name) {
        continue;
      }
      const normalizedName = name.trim().toLowerCase();
      if (normalizedName === 'artifactboard:deck-spec') {
        if (version === null) {
          version = sanitizeDeckSpecVersion(content);
        }
      } else if (normalizedName === 'artifactboard:features') {
        const parsed = sanitizeDeckFeatures(content);
        if (parsed.length > 0) {
          features = sanitizeDeckFeatures([...features, ...parsed]);
        }
      }
    }
  }

  const missingFromDeclared = CURRENT_REQUIRED_FEATURES.filter(
    (feature) => !features.includes(feature),
  );
  const upToDate =
    version !== null &&
    version >= CURRENT_DECK_SPEC_VERSION &&
    (features.length === 0 || missingFromDeclared.length === 0);
  const missingFeatures = upToDate ? [] : missingFromDeclared;

  return {
    version,
    label: version ? `v${version}` : 'Legacy',
    currentVersion: CURRENT_DECK_SPEC_VERSION,
    status: upToDate ? 'up_to_date' : 'needs_backfill',
    upToDate,
    features,
    detectedFeatures,
    missingFeatures,
    exportedWithVersion: null,
    exportedVia: null,
  };
}

function buildDeckSpecWarning(deckSpec) {
  const missingFeatures = Array.isArray(deckSpec?.missingFeatures) ? deckSpec.missingFeatures : [];
  const missingSummary =
    missingFeatures.length > 0 ? ` Missing features: ${missingFeatures.join(', ')}.` : '';
  const versionSummary = deckSpec?.version
    ? `Deck is on Deck Spec ${deckSpec.label} (current is v${CURRENT_DECK_SPEC_VERSION})`
    : `Deck is missing Deck Spec v${CURRENT_DECK_SPEC_VERSION} <meta> tags`;
  return (
    `${versionSummary}.${missingSummary} ` +
    'Use the companion backfill-artifactboard skill to upgrade this deck without losing content or styling.'
  );
}

async function readJsonFileIfExists(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function writePrivateJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Best-effort on filesystems without POSIX permissions.
  }

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const serialized = `${JSON.stringify(data, null, 2)}\n`;

  try {
    await writeFile(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(tempPath, 0o600);
    } catch {
      // Best-effort.
    }
    await rename(tempPath, filePath);
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Best-effort.
    }
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

function launchBrowserSafely(authorizeUrl) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', authorizeUrl];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [authorizeUrl];
  } else {
    command = 'xdg-open';
    args = [authorizeUrl];
  }

  try {
    const child = execFile(command, args, { windowsHide: true }, () => {});
    if (child && typeof child.on === 'function') {
      child.on('error', () => {});
    }
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch {
    // Ignore spawn errors; user can always open authorizeUrl manually.
  }
}

function formatToolResult(payload, isError = false) {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

class ToolExecutionError extends Error {
  constructor(code, message, status = undefined) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
    this.status = status;
  }
}

function extractSavedCredentials(savedCreds) {
  const token =
    typeof savedCreds?.token === 'string' && savedCreds.token.length > 0
      ? savedCreds.token
      : null;
  const handle = savedCreds?.handle ?? null;
  let origin = null;
  if (typeof savedCreds?.origin === 'string' && savedCreds.origin.trim().length > 0) {
    try {
      origin = validateAndNormalizeOrigin(savedCreds.origin);
    } catch {
      origin = null;
    }
  }
  return { token, origin, handle };
}

/**
 * Normalize an MCP clientInfo.name string into an allowlisted non-PII agent identifier.
 * @param {unknown} name
 * @returns {'antigravity' | 'claude-code' | 'mcp-other'}
 */
export function normalizeMcpClientAgent(name) {
  if (typeof name !== 'string') return 'mcp-other';
  if (/antigravity|gemini/i.test(name)) return 'antigravity';
  if (/claude/i.test(name)) return 'claude-code';
  return 'mcp-other';
}

/**
 * Create an ArtifactBoard MCP server instance exposing the 8 deck/auth tools.
 * @param {object} [options]
 * @param {string} [options.origin]
 * @param {string} [options.credentialsPath]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(url: string) => void | Promise<void>} [options.openBrowser]
 */
export function createArtifactBoardMcpServer(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch API (Node >= 22) is required.');
  }

  let detectedClientAgent = 'mcp-other';

  const credentialsPath =
    options.credentialsPath ||
    process.env.ARTIFACTBOARD_CONFIG_PATH ||
    path.join(os.homedir(), '.config', 'artifactboard', 'credentials.json');
  const pendingLoginPath = path.join(path.dirname(credentialsPath), 'pending-login.json');

  // Validate explicit origin upfront so misconfigurations fail fast.
  if (options.origin) {
    validateAndNormalizeOrigin(options.origin);
  } else if (process.env.ARTIFACTBOARD_ORIGIN) {
    validateAndNormalizeOrigin(process.env.ARTIFACTBOARD_ORIGIN);
  }

  async function loadAuthContext() {
    const savedCreds = await readJsonFileIfExists(credentialsPath);
    const hasSavedOriginField =
      typeof savedCreds?.origin === 'string' && savedCreds.origin.trim().length > 0;
    let savedOrigin = null;
    if (hasSavedOriginField) {
      try {
        savedOrigin = validateAndNormalizeOrigin(savedCreds.origin);
      } catch {
        savedOrigin = null;
      }
    }
    const rawOrigin =
      options.origin || process.env.ARTIFACTBOARD_ORIGIN || savedOrigin || DEFAULT_ORIGIN;
    const origin = validateAndNormalizeOrigin(rawOrigin);

    const envToken =
      typeof process.env.ARTIFACTBOARD_TOKEN === 'string' && process.env.ARTIFACTBOARD_TOKEN.length > 0
        ? process.env.ARTIFACTBOARD_TOKEN
        : null;
    if (envToken) {
      return { origin, token: envToken, tokenSource: 'env', savedCreds };
    }

    // Never transmit saved credentials to a different origin (or when saved origin is malformed/insecure).
    const originMatchesSaved = hasSavedOriginField ? savedOrigin === origin : true;
    const savedToken =
      originMatchesSaved &&
      typeof savedCreds?.token === 'string' &&
      savedCreds.token.length > 0
        ? savedCreds.token
        : null;
    return {
      origin,
      token: savedToken,
      tokenSource: savedToken ? 'credentials' : null,
      savedCreds,
    };
  }

  function buildHttpError(response, rawText, secretsToRedact = []) {
    let data = null;
    if (typeof rawText === 'string' && rawText.trim().length > 0) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }

    const serverCode =
      (typeof data?.code === 'string' && data.code) ||
      (typeof data?.error?.code === 'string' && data.error.code) ||
      `HTTP_${response.status}`;
    const serverMessage =
      (typeof data?.error === 'string' && data.error) ||
      (typeof data?.error?.message === 'string' && data.error.message) ||
      (typeof data?.message === 'string' && data.message) ||
      (typeof rawText === 'string' && rawText.trim().length > 0
        ? rawText.trim().slice(0, 300)
        : response.statusText);
    const safeMessage = sanitizeSecrets(serverMessage, secretsToRedact);
    return new ToolExecutionError(serverCode, safeMessage, response.status);
  }

  function buildRequestHeaders(initHeaders) {
    const headers = {};
    if (initHeaders instanceof Headers) {
      for (const [key, value] of initHeaders.entries()) {
        if (key.toLowerCase() !== 'x-ab-client') headers[key] = value;
      }
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        if (String(key).toLowerCase() !== 'x-ab-client') headers[key] = value;
      }
    } else if (initHeaders && typeof initHeaders === 'object') {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (key.toLowerCase() !== 'x-ab-client') headers[key] = value;
      }
    }
    headers['X-AB-Client'] = `${detectedClientAgent}/${SERVER_INFO.version}`;
    return headers;
  }

  async function requestJson(url, init = {}, secretsToRedact = []) {
    const headers = buildRequestHeaders(init.headers);

    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = sanitizeSecrets(
        err instanceof Error ? err.message : String(err),
        secretsToRedact,
      );
      throw new ToolExecutionError('NETWORK_ERROR', `Request to ${url} failed: ${msg}`);
    }

    const rawText = await response.text();
    if (!response.ok) {
      throw buildHttpError(response, rawText, secretsToRedact);
    }

    if (rawText.trim().length === 0) {
      return {};
    }
    try {
      return JSON.parse(rawText) ?? {};
    } catch {
      return {};
    }
  }

  async function requestBuffer(url, init = {}, secretsToRedact = []) {
    const headers = buildRequestHeaders(init.headers);
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = sanitizeSecrets(
        err instanceof Error ? err.message : String(err),
        secretsToRedact,
      );
      throw new ToolExecutionError('NETWORK_ERROR', `Request to ${url} failed: ${msg}`);
    }

    if (!response.ok) {
      let rawText = '';
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }
      throw buildHttpError(response, rawText, secretsToRedact);
    }

    const rawContentLength = response.headers?.get?.('content-length');
    if (rawContentLength !== null && rawContentLength !== undefined && rawContentLength !== '') {
      const declaredBytes = Number(rawContentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_DECK_BYTES) {
        await response.body?.cancel?.().catch(() => {});
        throw new ToolExecutionError(
          'DECK_TOO_LARGE',
          `Downloaded deck exceeds maximum allowed size of ${MAX_DECK_BYTES} bytes.`,
        );
      }
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value && value.byteLength > 0) {
            totalBytes += value.byteLength;
            if (totalBytes > MAX_DECK_BYTES) {
              await reader.cancel().catch(() => {});
              throw new ToolExecutionError(
                'DECK_TOO_LARGE',
                `Downloaded deck exceeds maximum allowed size of ${MAX_DECK_BYTES} bytes.`,
              );
            }
            chunks.push(Buffer.from(value));
          }
        }
      } catch (err) {
        if (err instanceof ToolExecutionError) {
          throw err;
        }
        const msg = sanitizeSecrets(
          err instanceof Error ? err.message : String(err),
          secretsToRedact,
        );
        throw new ToolExecutionError('NETWORK_ERROR', `Request to ${url} failed: ${msg}`);
      }
      return Buffer.concat(chunks, totalBytes);
    }

    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (err) {
      const msg = sanitizeSecrets(
        err instanceof Error ? err.message : String(err),
        secretsToRedact,
      );
      throw new ToolExecutionError('NETWORK_ERROR', `Request to ${url} failed: ${msg}`);
    }
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > MAX_DECK_BYTES) {
      throw new ToolExecutionError(
        'DECK_TOO_LARGE',
        `Downloaded deck exceeds maximum allowed size of ${MAX_DECK_BYTES} bytes.`,
      );
    }
    return buffer;
  }

  function normalizeExpectedHandle(rawExpectedHandle) {
    if (rawExpectedHandle === undefined) {
      return null;
    }
    if (typeof rawExpectedHandle !== 'string') {
      throw new ToolExecutionError(
        'INVALID_EXPECTED_HANDLE',
        'expected_handle must be a string (3-30 lowercase alphanumeric characters or hyphens, with optional leading @).',
      );
    }
    const normalized = rawExpectedHandle.trim().replace(/^@/, '').toLowerCase();
    if (!HANDLE_REGEX.test(normalized)) {
      throw new ToolExecutionError(
        'INVALID_EXPECTED_HANDLE',
        'expected_handle must be 3-30 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.',
      );
    }
    return normalized;
  }

  async function revokeTokenBestEffort(origin, token) {
    try {
      await requestJson(
        `${origin}/api/v1/cli/tokens/current`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        [token],
      );
      return { revoked: true };
    } catch (err) {
      const reason = sanitizeSecrets(
        err instanceof Error ? err.message : String(err),
        [token],
      );
      return { revoked: false, reason };
    }
  }

  async function requireAuth() {
    const { origin, token } = await loadAuthContext();
    if (!token) {
      throw new ToolExecutionError(
        'UNAUTHENTICATED',
        'Not logged in to ArtifactBoard. Call artifactboard_login() first.',
      );
    }
    return { origin, token };
  }

  async function handleStatus() {
    const { origin, token, tokenSource } = await loadAuthContext();
    if (!token) {
      return { authenticated: false, origin };
    }

    try {
      const data = await requestJson(
        `${origin}/api/v1/me`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        [token],
      );
      const user = data.user ?? data;
      const handle = user.handle ?? null;
      const boardUrl = handle ? `${origin}/${encodeURIComponent(handle)}/boards` : null;
      return {
        authenticated: true,
        origin,
        tokenSource,
        handle,
        email: user.email ?? null,
        boardUrl,
        tier: user.tier ?? 'starter',
        quota: {
          deckCount: user.deckCount ?? 0,
          totalDeckBytes: user.totalDeckBytes ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof ToolExecutionError && err.status === 401) {
        return {
          authenticated: false,
          origin,
          tokenSource,
          reason: err.message || 'Authentication token is invalid or revoked.',
        };
      }
      throw err;
    }
  }

  function validateAuthorizeUrl(rawUrl, targetOrigin) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new ToolExecutionError(
        'INVALID_AUTHORIZE_URL',
        'Authorization URL is missing or malformed.',
      );
    }
    let parsedAuthUrl;
    try {
      parsedAuthUrl = new URL(rawUrl);
    } catch {
      throw new ToolExecutionError(
        'INVALID_AUTHORIZE_URL',
        'Authorization URL is malformed.',
      );
    }
    if (parsedAuthUrl.username || parsedAuthUrl.password) {
      throw new ToolExecutionError(
        'INVALID_AUTHORIZE_URL',
        'Refusing to use authorizeUrl because it contains embedded credentials.',
      );
    }
    if (parsedAuthUrl.origin !== new URL(targetOrigin).origin) {
      throw new ToolExecutionError(
        'ORIGIN_MISMATCH',
        'Refusing to open authorizeUrl because its origin does not match the ArtifactBoard origin.',
      );
    }
    if (parsedAuthUrl.pathname !== '/cli/authorize') {
      throw new ToolExecutionError(
        'INVALID_AUTHORIZE_URL',
        'Refusing to open authorizeUrl because its path is not /cli/authorize.',
      );
    }
    return parsedAuthUrl.href;
  }

  async function openAuthorizeUrl(authorizeUrl) {
    if (typeof options.openBrowser === 'function') {
      await Promise.resolve()
        .then(() => options.openBrowser(authorizeUrl))
        .catch(() => {});
    } else {
      launchBrowserSafely(authorizeUrl);
    }
  }

  async function completeApprovedLogin(pollData, targetOrigin) {
    if (typeof pollData.rawToken !== 'string' || !pollData.rawToken) {
      throw new ToolExecutionError(
        'INVALID_SERVER_RESPONSE',
        'Approved login response did not include an access token.',
      );
    }
    const existingCreds = extractSavedCredentials(await readJsonFileIfExists(credentialsPath));
    const handle = pollData.handle ?? null;
    await writePrivateJsonFile(credentialsPath, {
      origin: targetOrigin,
      token: pollData.rawToken,
      handle,
      savedAt: new Date().toISOString(),
    });
    await unlink(pendingLoginPath).catch(() => {});

    const loginResult = {
      authenticated: true,
      handle,
      boardUrl: handle ? `${targetOrigin}/${encodeURIComponent(handle)}/boards` : null,
      credentialsPath,
    };
    if (
      existingCreds.token &&
      existingCreds.origin &&
      existingCreds.token !== pollData.rawToken
    ) {
      const revokeResult = await revokeTokenBestEffort(
        existingCreds.origin,
        existingCreds.token,
      );
      loginResult.previousTokenRevoked = revokeResult.revoked;
    }
    if (process.env.ARTIFACTBOARD_TOKEN) {
      loginResult.warning =
        'ARTIFACTBOARD_TOKEN is set in your environment and overrides the newly saved credentials file until unset.';
    }
    return loginResult;
  }

  async function pollDeviceOnce(targetOrigin, deviceCode) {
    const pollData = await requestJson(
      `${targetOrigin}/api/v1/cli/device/poll`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      },
      [deviceCode],
    );

    if (pollData.status === 'approved') {
      return { done: true, result: await completeApprovedLogin(pollData, targetOrigin) };
    }

    if (pollData.status === 'expired') {
      await unlink(pendingLoginPath).catch(() => {});
      throw new ToolExecutionError(
        'LOGIN_EXPIRED',
        'Device login session expired before approval. Call artifactboard_login() to start a new login.',
      );
    }

    return { done: false };
  }

  async function handleLogin(args) {
    if (args.wait_for_approval !== undefined && typeof args.wait_for_approval !== 'boolean') {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'wait_for_approval must be a boolean.');
    }
    if (args.resume_pending !== undefined && typeof args.resume_pending !== 'boolean') {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'resume_pending must be a boolean.');
    }
    if (args.open_browser !== undefined && typeof args.open_browser !== 'boolean') {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'open_browser must be a boolean.');
    }
    if (
      args.open_delay_ms !== undefined &&
      (typeof args.open_delay_ms !== 'number' || !Number.isFinite(args.open_delay_ms))
    ) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'open_delay_ms must be a finite number.');
    }
    if (
      args.poll_timeout_ms !== undefined &&
      (typeof args.poll_timeout_ms !== 'number' || !Number.isFinite(args.poll_timeout_ms))
    ) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'poll_timeout_ms must be a finite number.');
    }
    if (
      args.poll_interval_ms !== undefined &&
      (typeof args.poll_interval_ms !== 'number' || !Number.isFinite(args.poll_interval_ms))
    ) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'poll_interval_ms must be a finite number.');
    }

    const resumePending = args.resume_pending ?? false;
    const waitForApproval = args.wait_for_approval ?? resumePending;
    const pollTimeoutMs = clamp(args.poll_timeout_ms ?? 60_000, 500, 300_000);
    const pollIntervalMs = clamp(args.poll_interval_ms ?? 1500, 50, 30_000);
    const hasCustomOpenBrowser = typeof options.openBrowser === 'function';
    const openDelayMs =
      args.open_delay_ms !== undefined
        ? clamp(args.open_delay_ms, 0, MAX_OPEN_DELAY_MS)
        : resumePending && !hasCustomOpenBrowser
          ? DEFAULT_RESUME_OPEN_DELAY_MS
          : 0;
    const browserDisabledByEnv = process.env.ARTIFACTBOARD_NO_BROWSER === '1';

    const { origin: configuredOrigin } = await loadAuthContext();
    let targetOrigin = configuredOrigin;
    let deviceCode;
    let authorizeUrl;
    let userCode;
    let expiresAt = null;
    let browserOpened = false;
    let alreadyPolledPending = false;

    if (resumePending) {
      const pending = await readJsonFileIfExists(pendingLoginPath);
      if (!pending || typeof pending.deviceCode !== 'string' || !pending.deviceCode) {
        throw new ToolExecutionError(
          'NO_PENDING_LOGIN',
          'No pending device login found. Call artifactboard_login() to start a new login.',
        );
      }
      if (pending.origin) {
        try {
          targetOrigin = validateAndNormalizeOrigin(pending.origin);
        } catch (err) {
          throw new ToolExecutionError(
            'INVALID_PENDING_LOGIN',
            err instanceof Error ? err.message : 'Pending login contains an invalid origin.',
          );
        }
      } else {
        targetOrigin = configuredOrigin;
      }
      if (options.origin || process.env.ARTIFACTBOARD_ORIGIN) {
        if (targetOrigin !== configuredOrigin) {
          throw new ToolExecutionError(
            'ORIGIN_MISMATCH',
            `Pending login belongs to ${targetOrigin}, which does not match configured origin ${configuredOrigin}.`,
          );
        }
      }
      if (typeof pending.expiresAt === 'string') {
        const expiresAtMs = Date.parse(pending.expiresAt);
        if (Number.isFinite(expiresAtMs)) {
          if (Date.now() >= expiresAtMs) {
            await unlink(pendingLoginPath).catch(() => {});
            throw new ToolExecutionError(
              'LOGIN_EXPIRED',
              'Device login session expired before approval. Call artifactboard_login() to start a new login.',
            );
          }
          expiresAt = pending.expiresAt;
        }
      }

      deviceCode = pending.deviceCode;
      authorizeUrl = validateAuthorizeUrl(pending.authorizeUrl, targetOrigin);
      userCode =
        typeof pending.userCode === 'string' && pending.userCode.trim().length > 0
          ? pending.userCode.trim()
          : null;
      const previouslyOpened = pending.browserOpened === true;
      browserOpened = previouslyOpened;
      const shouldOpenBrowser =
        !browserDisabledByEnv &&
        (args.open_browser !== undefined ? args.open_browser : !previouslyOpened);

      if (shouldOpenBrowser || !waitForApproval) {
        const initialPoll = await pollDeviceOnce(targetOrigin, deviceCode);
        if (initialPoll.done) {
          return initialPoll.result;
        }
        alreadyPolledPending = true;
      }

      if (shouldOpenBrowser) {
        if (openDelayMs > 0) {
          await delay(openDelayMs);
        }
        await writePrivateJsonFile(pendingLoginPath, {
          deviceCode,
          authorizeUrl,
          userCode,
          origin: targetOrigin,
          expiresAt,
          browserOpened: true,
        });
        await openAuthorizeUrl(authorizeUrl);
        browserOpened = true;
      }
    } else {
      const startData = await requestJson(`${targetOrigin}/api/v1/cli/device/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (
        typeof startData.deviceCode !== 'string' ||
        !startData.deviceCode ||
        typeof startData.authorizeUrl !== 'string' ||
        !startData.authorizeUrl ||
        typeof startData.userCode !== 'string' ||
        !startData.userCode.trim()
      ) {
        throw new ToolExecutionError(
          'INVALID_SERVER_RESPONSE',
          'Device start response did not include deviceCode, userCode, and authorizeUrl.',
        );
      }

      authorizeUrl = validateAuthorizeUrl(startData.authorizeUrl, targetOrigin);
      deviceCode = startData.deviceCode;
      userCode = startData.userCode.trim();
      const expiresInSeconds = Number(startData.expiresIn) > 0 ? Number(startData.expiresIn) : 300;
      expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      const shouldOpenBrowser = !browserDisabledByEnv && args.open_browser === true;
      await writePrivateJsonFile(pendingLoginPath, {
        deviceCode,
        authorizeUrl,
        userCode,
        origin: targetOrigin,
        expiresAt,
        browserOpened: false,
      });

      if (shouldOpenBrowser) {
        if (openDelayMs > 0) {
          await delay(openDelayMs);
        }
        await writePrivateJsonFile(pendingLoginPath, {
          deviceCode,
          authorizeUrl,
          userCode,
          origin: targetOrigin,
          expiresAt,
          browserOpened: true,
        });
        await openAuthorizeUrl(authorizeUrl);
        browserOpened = true;
      }
    }

    const codeLabel = userCode ? `confirmation code ${userCode}` : 'the device confirmation code';
    const buildPendingResult = (message) => ({
      authenticated: false,
      status: 'pending',
      authorizeUrl,
      userCode,
      expiresAt,
      browserOpened,
      message,
    });

    if (!waitForApproval) {
      if (browserOpened) {
        return buildPendingResult(
          `Approve ${codeLabel} in your browser, then call artifactboard_login({ resume_pending: true, open_browser: false })`,
        );
      }
      if (browserDisabledByEnv) {
        return buildPendingResult(
          `Browser auto-open is disabled (ARTIFACTBOARD_NO_BROWSER=1). Show ${codeLabel} and ${authorizeUrl} in chat so the user can approve in a browser, then call artifactboard_login({ resume_pending: true, open_browser: false })`,
        );
      }
      return buildPendingResult(
        `Show ${codeLabel} to the user in chat first and let them know a browser popup is coming up to confirm, then call artifactboard_login({ resume_pending: true, open_browser: true })`,
      );
    }

    const buildTimeoutResult = () =>
      buildPendingResult(
        browserOpened
          ? `Still waiting for browser approval of ${codeLabel}. Approve in browser, then call artifactboard_login({ resume_pending: true, open_browser: false })`
          : `Still waiting for approval of ${codeLabel}. Have the user open ${authorizeUrl} to approve, then call artifactboard_login({ resume_pending: true, open_browser: false })`,
      );

    const deadline = Date.now() + pollTimeoutMs;
    if (alreadyPolledPending) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return buildTimeoutResult();
      }
      await delay(Math.min(pollIntervalMs, remaining));
    }

    while (true) {
      const poll = await pollDeviceOnce(targetOrigin, deviceCode);
      if (poll.done) {
        return poll.result;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return buildTimeoutResult();
      }

      await delay(Math.min(pollIntervalMs, remaining));
    }
  }

  async function unlinkIfExists(filePath, extraSecrets = []) {
    try {
      await unlink(filePath);
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return;
      }
      throw new ToolExecutionError(
        'LOGOUT_UNLINK_FAILED',
        `Unable to remove local credential file "${filePath}": ${sanitizeSecrets(
          err instanceof Error ? err.message : String(err),
          extraSecrets,
        )}`,
      );
    }
  }

  async function handleLogout(args) {
    if (args.revoke_remote !== undefined && typeof args.revoke_remote !== 'boolean') {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'revoke_remote must be a boolean.');
    }
    const revokeRemote = args.revoke_remote ?? true;
    const savedCreds = await readJsonFileIfExists(credentialsPath);
    const {
      token: savedToken,
      origin: savedOrigin,
      handle: previousHandle,
    } = extractSavedCredentials(savedCreds);

    let remoteRevoked = false;
    let remoteWarning = null;
    if (revokeRemote && savedToken && savedOrigin) {
      const revokeResult = await revokeTokenBestEffort(savedOrigin, savedToken);
      remoteRevoked = revokeResult.revoked;
      if (!revokeResult.revoked && revokeResult.reason) {
        remoteWarning = revokeResult.reason;
      }
    }

    await unlinkIfExists(credentialsPath, savedToken ? [savedToken] : []);
    await unlinkIfExists(pendingLoginPath);

    return {
      loggedOut: true,
      hadCredentials: Boolean(savedToken),
      previousHandle,
      remoteRevoked,
      credentialsPath,
      ...(remoteWarning ? { remoteWarning } : {}),
      ...(process.env.ARTIFACTBOARD_TOKEN
        ? {
            warning:
              'ARTIFACTBOARD_TOKEN is set in your environment and remains active until unset.',
          }
        : {}),
    };
  }

  async function handleExportDeck(args) {
    if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'file_path must be a non-empty string.');
    }

    const resolvedPath = path.resolve(args.file_path);
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!ALLOWED_HTML_EXTENSIONS.has(ext)) {
      throw new ToolExecutionError(
        'INVALID_FILE_TYPE',
        'file_path must point to an .html or .htm file.',
      );
    }

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch (err) {
      throw new ToolExecutionError(
        'FILE_NOT_FOUND',
        `Unable to stat file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!fileStats.isFile()) {
      throw new ToolExecutionError('INVALID_FILE_TYPE', 'file_path must point to a regular file.');
    }
    if (fileStats.size < 1 || fileStats.size > MAX_DECK_BYTES) {
      throw new ToolExecutionError(
        'INVALID_FILE_SIZE',
        `Deck file size must be between 1 and ${MAX_DECK_BYTES} bytes (got ${fileStats.size} bytes).`,
      );
    }

    if (args.slug !== undefined) {
      if (typeof args.slug !== 'string' || !SLUG_REGEX.test(args.slug)) {
        throw new ToolExecutionError(
          'INVALID_SLUG',
          'slug must be 1-64 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.',
        );
      }
    }

    if (args.visibility !== undefined) {
      if (typeof args.visibility !== 'string' || !DECK_VISIBILITIES.has(args.visibility)) {
        throw new ToolExecutionError(
          'INVALID_VISIBILITY',
          'visibility must be one of: private, unlisted, public.',
        );
      }
    }

    if (args.title !== undefined && typeof args.title !== 'string') {
      throw new ToolExecutionError('INVALID_TITLE', 'title must be a string.');
    }

    const normalizedExpectedHandle = normalizeExpectedHandle(args.expected_handle);

    const { origin, token } = await requireAuth();

    const htmlBuffer = await readFile(resolvedPath);
    if (htmlBuffer.byteLength < 1 || htmlBuffer.byteLength > MAX_DECK_BYTES) {
      throw new ToolExecutionError(
        'INVALID_FILE_SIZE',
        `Deck file size must be between 1 and ${MAX_DECK_BYTES} bytes.`,
      );
    }

    const explicitTitle = typeof args.title === 'string' ? args.title.trim() : '';
    const extractedTitle = explicitTitle ? '' : extractHtmlTitle(htmlBuffer);
    const fallbackName = path.basename(resolvedPath, ext);
    const finalTitle = truncateUtf16Safe(
      explicitTitle || extractedTitle || fallbackName || 'Untitled Deck',
      MAX_TITLE_LENGTH,
    );
    const finalSlug = args.slug !== undefined ? args.slug : slugifyTitle(finalTitle, fallbackName);

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/html; charset=utf-8',
      'X-Deck-Title': encodeURIComponent(finalTitle),
      'X-ArtifactBoard-Client': 'mcp',
      'X-ArtifactBoard-Plugin-Version': SERVER_INFO.version,
    };
    if (args.visibility !== undefined) {
      headers['X-Deck-Visibility'] = args.visibility;
    }
    if (normalizedExpectedHandle !== null) {
      headers['X-Expected-Handle'] = normalizedExpectedHandle;
    }

    const data = await requestJson(
      `${origin}/api/v1/decks/${encodeURIComponent(finalSlug)}`,
      {
        method: 'PUT',
        headers,
        body: htmlBuffer,
      },
      [token],
    );

    const deckSpec = data.deckSpec || {
      ...inspectDeckHtmlMetadata(htmlBuffer),
      exportedWithVersion: SERVER_INFO.version,
      exportedVia: 'mcp',
    };

    return {
      handle: data.handle,
      slug: data.slug,
      title: data.title,
      visibility: data.visibility,
      sizeBytes: data.sizeBytes,
      boardUrl: data.boardUrl,
      presentUrl: data.presentUrl,
      unlistedUrl: data.unlistedUrl,
      deckSpec,
      ...(!deckSpec.upToDate ? { warning: buildDeckSpecWarning(deckSpec) } : {}),
    };
  }

  async function handleListDecks() {
    const { origin, token } = await requireAuth();
    const data = await requestJson(
      `${origin}/api/v1/decks`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      [token],
    );
    const decks = Array.isArray(data.decks) ? data.decks : [];
    return {
      user: data.user,
      currentDeckSpecVersion: data.currentDeckSpecVersion ?? CURRENT_DECK_SPEC_VERSION,
      outdatedCount: Number.isInteger(data.outdatedCount)
        ? data.outdatedCount
        : decks.filter((d) => d?.deckSpec?.upToDate === false).length,
      decks,
    };
  }

  async function handleDownloadDeck(args) {
    if (typeof args.slug !== 'string' || !SLUG_REGEX.test(args.slug)) {
      throw new ToolExecutionError(
        'INVALID_SLUG',
        'slug must be 1-64 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.',
      );
    }
    if (typeof args.output_path !== 'string' || args.output_path.trim().length === 0) {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'output_path must be a non-empty string.');
    }
    if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
      throw new ToolExecutionError('INVALID_ARGUMENTS', 'overwrite must be a boolean.');
    }
    const overwrite = args.overwrite === true;
    const normalizedExpectedHandle = normalizeExpectedHandle(args.expected_handle);

    const resolvedPath = path.resolve(args.output_path);
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!ALLOWED_HTML_EXTENSIONS.has(ext)) {
      throw new ToolExecutionError(
        'INVALID_OUTPUT_PATH',
        'output_path must point to an .html or .htm file.',
      );
    }

    let existingStats = null;
    try {
      existingStats = await lstat(resolvedPath);
    } catch (err) {
      if (!err || typeof err !== 'object' || err.code !== 'ENOENT') {
        throw new ToolExecutionError(
          'INVALID_OUTPUT_PATH',
          `Unable to inspect output_path "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (existingStats) {
      if (existingStats.isSymbolicLink() || existingStats.isDirectory() || !existingStats.isFile()) {
        throw new ToolExecutionError(
          'INVALID_OUTPUT_PATH',
          'output_path must not be a symbolic link, directory, or non-regular file.',
        );
      }
      if (!overwrite) {
        throw new ToolExecutionError(
          'FILE_EXISTS',
          'Output file already exists. Pass overwrite: true or choose a new output_path.',
        );
      }
    }

    const { origin, token } = await requireAuth();
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    if (normalizedExpectedHandle !== null) {
      headers['X-Expected-Handle'] = normalizedExpectedHandle;
    }

    const htmlBuffer = await requestBuffer(
      `${origin}/api/v1/decks/${encodeURIComponent(args.slug)}/html`,
      {
        method: 'GET',
        headers,
      },
      [token],
    );

    if (htmlBuffer.byteLength < 1) {
      throw new ToolExecutionError(
        'EMPTY_RESPONSE',
        `Downloaded deck "${args.slug}" was empty; local file was not modified.`,
      );
    }

    try {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
    } catch (err) {
      throw new ToolExecutionError(
        'WRITE_FAILED',
        `Unable to prepare output directory for "${resolvedPath}": ${sanitizeSecrets(
          err instanceof Error ? err.message : String(err),
          [token],
        )}`,
      );
    }

    if (!overwrite) {
      try {
        await writeFile(resolvedPath, htmlBuffer, { flag: 'wx' });
      } catch (err) {
        if (err && typeof err === 'object' && err.code === 'EEXIST') {
          throw new ToolExecutionError(
            'FILE_EXISTS',
            'Output file already exists. Pass overwrite: true or choose a new output_path.',
          );
        }
        throw new ToolExecutionError(
          'WRITE_FAILED',
          `Unable to write downloaded deck to "${resolvedPath}": ${sanitizeSecrets(
            err instanceof Error ? err.message : String(err),
            [token],
          )}`,
        );
      }
    } else {
      const tempPath = `${resolvedPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tempPath, htmlBuffer, { flag: 'wx' });
        let currentStats = null;
        try {
          currentStats = await lstat(resolvedPath);
        } catch (err) {
          if (!err || typeof err !== 'object' || err.code !== 'ENOENT') {
            throw err;
          }
        }
        if (
          currentStats &&
          (currentStats.isSymbolicLink() || currentStats.isDirectory() || !currentStats.isFile())
        ) {
          throw new ToolExecutionError(
            'INVALID_OUTPUT_PATH',
            'output_path must not be a symbolic link, directory, or non-regular file.',
          );
        }
        await rename(tempPath, resolvedPath);
      } catch (err) {
        await unlink(tempPath).catch(() => {});
        if (err instanceof ToolExecutionError) {
          throw err;
        }
        throw new ToolExecutionError(
          'WRITE_FAILED',
          `Unable to write downloaded deck to "${resolvedPath}": ${sanitizeSecrets(
            err instanceof Error ? err.message : String(err),
            [token],
          )}`,
        );
      }
    }

    const sha256 = crypto.createHash('sha256').update(htmlBuffer).digest('hex');
    const deckSpec = inspectDeckHtmlMetadata(htmlBuffer);

    return {
      slug: args.slug,
      filePath: resolvedPath,
      sizeBytes: htmlBuffer.byteLength,
      sha256,
      deckSpec,
    };
  }

  async function handleUpdateDeck(args) {
    if (typeof args.slug !== 'string' || !SLUG_REGEX.test(args.slug)) {
      throw new ToolExecutionError(
        'INVALID_SLUG',
        'slug must be 1-64 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.',
      );
    }

    const patchBody = {};
    if (args.title !== undefined) {
      if (typeof args.title !== 'string' || args.title.length > MAX_TITLE_LENGTH) {
        throw new ToolExecutionError(
          'INVALID_TITLE',
          `title must be a string up to ${MAX_TITLE_LENGTH} characters.`,
        );
      }
      patchBody.title = args.title;
    }
    if (args.visibility !== undefined) {
      if (typeof args.visibility !== 'string' || !DECK_VISIBILITIES.has(args.visibility)) {
        throw new ToolExecutionError(
          'INVALID_VISIBILITY',
          'visibility must be one of: private, unlisted, public.',
        );
      }
      patchBody.visibility = args.visibility;
    }
    if (args.rotate_unlisted_key !== undefined) {
      if (typeof args.rotate_unlisted_key !== 'boolean') {
        throw new ToolExecutionError('INVALID_ARGUMENTS', 'rotate_unlisted_key must be a boolean.');
      }
      if (args.rotate_unlisted_key) {
        patchBody.rotate_unlisted_key = true;
      }
    }

    if (
      patchBody.title === undefined &&
      patchBody.visibility === undefined &&
      !patchBody.rotate_unlisted_key
    ) {
      throw new ToolExecutionError(
        'EMPTY_PATCH',
        'Provide at least one of title, visibility, or rotate_unlisted_key: true.',
      );
    }

    const { origin, token } = await requireAuth();
    const data = await requestJson(
      `${origin}/api/v1/decks/${encodeURIComponent(args.slug)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      },
      [token],
    );

    if (data.deck && !data.boardUrl) {
      return { deck: data.deck };
    }
    return {
      handle: data.handle,
      slug: data.slug,
      title: data.title,
      visibility: data.visibility,
      sizeBytes: data.sizeBytes,
      boardUrl: data.boardUrl,
      presentUrl: data.presentUrl,
      unlistedUrl: data.unlistedUrl,
    };
  }

  async function handleDeleteDeck(args) {
    if (typeof args.slug !== 'string' || !SLUG_REGEX.test(args.slug)) {
      throw new ToolExecutionError(
        'INVALID_SLUG',
        'slug must be 1-64 lowercase alphanumeric characters or hyphens, starting and ending with alphanumeric.',
      );
    }

    const { origin, token } = await requireAuth();
    return await requestJson(
      `${origin}/api/v1/decks/${encodeURIComponent(args.slug)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      [token],
    );
  }

  async function callTool(name, args = {}) {
    if (!isPlainObject(args)) {
      return formatToolResult(
        { error: 'INVALID_ARGUMENTS', message: 'Tool arguments must be a JSON object.' },
        true,
      );
    }

    try {
      let payload;
      switch (name) {
        case 'artifactboard_status':
          payload = await handleStatus();
          break;
        case 'artifactboard_login':
          payload = await handleLogin(args);
          break;
        case 'artifactboard_export_deck':
          payload = await handleExportDeck(args);
          break;
        case 'artifactboard_list_decks':
          payload = await handleListDecks();
          break;
        case 'artifactboard_update_deck':
          payload = await handleUpdateDeck(args);
          break;
        case 'artifactboard_delete_deck':
          payload = await handleDeleteDeck(args);
          break;
        case 'artifactboard_logout':
          payload = await handleLogout(args);
          break;
        case 'artifactboard_download_deck':
          payload = await handleDownloadDeck(args);
          break;
        default:
          return formatToolResult(
            { error: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` },
            true,
          );
      }
      return formatToolResult(payload, false);
    } catch (err) {
      if (err instanceof ToolExecutionError) {
        return formatToolResult(
          {
            error: err.code,
            ...(err.status !== undefined ? { status: err.status } : {}),
            message: sanitizeSecrets(err.message),
          },
          true,
        );
      }
      return formatToolResult(
        {
          error: 'INTERNAL_ERROR',
          message: sanitizeSecrets(err instanceof Error ? err.message : String(err)),
        },
        true,
      );
    }
  }

  async function handleMessage(msg) {
    if (!isPlainObject(msg)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
    const validId =
      !hasId ||
      msg.id === null ||
      typeof msg.id === 'string' ||
      (typeof msg.id === 'number' && Number.isFinite(msg.id));
    const replyId = hasId && validId ? msg.id : null;

    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method.length === 0 || !validId) {
      return {
        jsonrpc: '2.0',
        id: replyId,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }

    // Notifications never receive a JSON-RPC response.
    if (!hasId) {
      return null;
    }

    const { method, params } = msg;

    if (method === 'initialize') {
      if (params !== undefined && !isPlainObject(params)) {
        return {
          jsonrpc: '2.0',
          id: replyId,
          error: { code: -32602, message: 'Invalid params: initialize params must be an object.' },
        };
      }
      detectedClientAgent = normalizeMcpClientAgent(params?.clientInfo?.name);
      const requestedVersion = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: '2.0',
        id: replyId,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id: replyId,
        result: {},
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: replyId,
        result: {
          tools: TOOLS,
        },
      };
    }

    if (method === 'tools/call') {
      if (!isPlainObject(params)) {
        return {
          jsonrpc: '2.0',
          id: replyId,
          error: { code: -32602, message: 'Invalid params: params must be an object.' },
        };
      }
      if (typeof params.name !== 'string' || params.name.length === 0) {
        return {
          jsonrpc: '2.0',
          id: replyId,
          error: { code: -32602, message: 'Invalid params: params.name must be a non-empty string.' },
        };
      }
      if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
        return {
          jsonrpc: '2.0',
          id: replyId,
          error: { code: -32602, message: 'Invalid params: params.arguments must be an object.' },
        };
      }
      if (!TOOL_NAMES.has(params.name)) {
        return {
          jsonrpc: '2.0',
          id: replyId,
          error: { code: -32602, message: `Invalid params: unknown tool "${params.name}".` },
        };
      }

      const result = await callTool(params.name, params.arguments ?? {});
      return {
        jsonrpc: '2.0',
        id: replyId,
        result,
      };
    }

    return {
      jsonrpc: '2.0',
      id: replyId,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return {
    serverInfo: SERVER_INFO,
    capabilities: { tools: {} },
    credentialsPath,
    listTools: () => TOOLS,
    callTool,
    handleMessage,
  };
}

function writeFrame(output, payload, framing) {
  const json = JSON.stringify(payload);
  if (framing === 'content-length') {
    const byteLength = Buffer.byteLength(json, 'utf8');
    output.write(`Content-Length: ${byteLength}\r\n\r\n${json}`);
  } else {
    output.write(`${json}\n`);
  }
}

function writeJsonRpcError(output, id, code, message, framing) {
  writeFrame(
    output,
    {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    },
    framing,
  );
}

/**
 * Attach a JSON-RPC 2.0 stdio transport supporting both newline-delimited JSON
 * and Content-Length header framing.
 * @param {ReturnType<typeof createArtifactBoardMcpServer>} server
 * @param {NodeJS.ReadableStream} [input]
 * @param {NodeJS.WritableStream} [output]
 */
export function attachMcpStdio(server, input = process.stdin, output = process.stdout) {
  let buffer = Buffer.alloc(0);
  let inputEnded = false;
  let closed = false;

  function dispatchFrame(rawJson, framing) {
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      writeJsonRpcError(output, null, -32700, 'Parse error', framing);
      return;
    }

    Promise.resolve(server.handleMessage(parsed))
      .then((response) => {
        if (!closed && response !== null && response !== undefined) {
          writeFrame(output, response, framing);
        }
      })
      .catch((err) => {
        const safeMsg = sanitizeSecrets(err instanceof Error ? err.message : String(err));
        process.stderr.write(`[artifactboard-mcp] internal error: ${safeMsg}\n`);
        if (
          !closed &&
          isPlainObject(parsed) &&
          Object.hasOwn(parsed, 'id') &&
          parsed.id !== undefined
        ) {
          const replyId =
            parsed.id === null || typeof parsed.id === 'string' || typeof parsed.id === 'number'
              ? parsed.id
              : null;
          writeJsonRpcError(output, replyId, -32603, 'Internal error', framing);
        }
      });
  }

  function drainBuffer() {
    while (buffer.byteLength > 0) {
      let start = 0;
      while (start < buffer.byteLength && (buffer[start] === 0x0d || buffer[start] === 0x0a)) {
        start += 1;
      }
      if (start > 0) {
        buffer = buffer.subarray(start);
      }
      if (buffer.byteLength === 0) {
        break;
      }

      const firstByte = buffer[0];
      const couldBeHeader = firstByte !== 0x7b && firstByte !== 0x5b;

      if (couldBeHeader) {
        const prefixLen = Math.min(buffer.byteLength, 16);
        const prefixLower = buffer.subarray(0, prefixLen).toString('ascii').toLowerCase();
        const isPartialHeaderPrefix =
          !inputEnded &&
          buffer.indexOf(0x0a) === -1 &&
          ('content-length:'.startsWith(prefixLower) || 'content-type:'.startsWith(prefixLower));

        if (isPartialHeaderPrefix) {
          break;
        }

        if (prefixLower.startsWith('content-length:') || prefixLower.startsWith('content-type:')) {
          const crlfIdx = buffer.indexOf('\r\n\r\n');
          const lfIdx = buffer.indexOf('\n\n');
          let headerEnd = -1;
          let sepLen = 0;
          if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
            headerEnd = crlfIdx;
            sepLen = 4;
          } else if (lfIdx !== -1) {
            headerEnd = lfIdx;
            sepLen = 2;
          }

          if (headerEnd === -1) {
            if (buffer.byteLength > MAX_HEADER_BYTES) {
              buffer = Buffer.alloc(0);
              writeJsonRpcError(output, null, -32700, 'Header too large', 'content-length');
            }
            break;
          }

          const headerText = buffer.subarray(0, headerEnd).toString('ascii');
          const lengthMatch = /^content-length\s*:\s*(\d+)\s*$/im.exec(headerText);
          if (!lengthMatch) {
            buffer = buffer.subarray(headerEnd + sepLen);
            writeJsonRpcError(
              output,
              null,
              -32700,
              'Invalid Content-Length header',
              'content-length',
            );
            continue;
          }

          const contentLength = Number(lengthMatch[1]);
          if (
            !Number.isSafeInteger(contentLength) ||
            contentLength < 0 ||
            contentLength > MAX_FRAME_BYTES
          ) {
            buffer = buffer.subarray(headerEnd + sepLen);
            writeJsonRpcError(
              output,
              null,
              -32700,
              'Invalid Content-Length value',
              'content-length',
            );
            continue;
          }

          const bodyStart = headerEnd + sepLen;
          const bodyEnd = bodyStart + contentLength;
          if (buffer.byteLength < bodyEnd) {
            break;
          }

          const bodyBuf = buffer.subarray(bodyStart, bodyEnd);
          buffer = buffer.subarray(bodyEnd);
          const rawJson = bodyBuf.toString('utf8');
          dispatchFrame(rawJson, 'content-length');
          continue;
        }
      }

      const nlIdx = buffer.indexOf(0x0a);
      if (nlIdx === -1) {
        if (inputEnded) {
          const rawJson = buffer.toString('utf8').trim();
          buffer = Buffer.alloc(0);
          if (rawJson.length > 0) {
            dispatchFrame(rawJson, 'ndjson');
          }
        } else if (buffer.byteLength > MAX_FRAME_BYTES) {
          buffer = Buffer.alloc(0);
          writeJsonRpcError(output, null, -32700, 'Frame too large', 'ndjson');
        }
        break;
      }

      let lineBuf = buffer.subarray(0, nlIdx);
      if (lineBuf.byteLength > 0 && lineBuf[lineBuf.byteLength - 1] === 0x0d) {
        lineBuf = lineBuf.subarray(0, lineBuf.byteLength - 1);
      }
      buffer = buffer.subarray(nlIdx + 1);
      const rawJson = lineBuf.toString('utf8').trim();
      if (rawJson.length > 0) {
        dispatchFrame(rawJson, 'ndjson');
      }
    }
  }

  function onData(chunk) {
    if (closed) {
      return;
    }
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    buffer = buffer.byteLength === 0 ? chunkBuf : Buffer.concat([buffer, chunkBuf]);
    drainBuffer();
  }

  function onEnd() {
    if (closed) {
      return;
    }
    inputEnded = true;
    drainBuffer();
  }

  function onError(err) {
    const safeMsg = sanitizeSecrets(err instanceof Error ? err.message : String(err));
    process.stderr.write(`[artifactboard-mcp] stream error: ${safeMsg}\n`);
  }

  function onOutputError(err) {
    closed = true;
    if (err && typeof err === 'object' && err.code === 'EPIPE') {
      return;
    }
    const safeMsg = sanitizeSecrets(err instanceof Error ? err.message : String(err));
    process.stderr.write(`[artifactboard-mcp] output error: ${safeMsg}\n`);
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onError);
  if (typeof output.on === 'function') {
    output.on('error', onOutputError);
  }

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      if (typeof output.off === 'function') {
        output.off('error', onOutputError);
      }
    },
  };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const selfPath = realpathSync(fileURLToPath(import.meta.url));
    const entryPath = realpathSync(process.argv[1]);
    if (process.platform === 'win32') {
      return selfPath.toLowerCase() === entryPath.toLowerCase();
    }
    return selfPath === entryPath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const server = createArtifactBoardMcpServer();
    attachMcpStdio(server, process.stdin, process.stdout);
  } catch (err) {
    const safeMsg = sanitizeSecrets(err instanceof Error ? err.message : String(err));
    process.stderr.write(`[artifactboard-mcp] fatal startup error: ${safeMsg}\n`);
    process.exitCode = 1;
  }
}
