import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
const SERVER_INFO = Object.freeze({ name: 'artifactboard', version: '1.0.0' });
const SERVER_INSTRUCTIONS =
  'Author slide decks as a single self-contained .html file (<= 5 MB) with all CSS, JS, and SVG inlined and no external CDN scripts or stylesheets. Published decks render in an origin-isolated sandbox (sandbox="allow-scripts", connect-src \'none\'): guard any localStorage/sessionStorage access in try/catch, avoid fetch()/XHR/WebSocket calls, and skip document.startViewTransition() when framed (window.self !== window.top). Always write the .html deck to disk first, then call artifactboard_export_deck with file_path instead of passing HTML inline.';

const MAX_DECK_BYTES = 5_242_880;
const MAX_TITLE_LENGTH = 140;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DECK_VISIBILITIES = new Set(['private', 'unlisted', 'public']);
const ALLOWED_HTML_EXTENSIONS = new Set(['.html', '.htm']);

const TOOLS = Object.freeze([
  {
    name: 'artifactboard_status',
    description:
      'Check ArtifactBoard authentication status, handle, board URL, tier, and deck storage quota.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_login',
    description:
      'Authenticate with ArtifactBoard via browser device flow and save credentials locally (0600 permissions).',
    inputSchema: {
      type: 'object',
      properties: {
        wait_for_approval: {
          type: 'boolean',
          description: 'Whether to poll until browser approval completes (default: true).',
          default: true,
        },
        resume_pending: {
          type: 'boolean',
          description: 'Resume polling a previously started pending login from disk.',
          default: false,
        },
        open_browser: {
          type: 'boolean',
          description: 'Open the authorization URL in the default browser.',
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
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifactboard_list_decks',
    description: 'List all decks on your ArtifactBoard along with share URLs and quota summary.',
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

/**
 * Create an ArtifactBoard MCP server instance exposing the 6 deck/auth tools.
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

  async function requestJson(url, init = {}, secretsToRedact = []) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
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
    let data = null;
    if (rawText.trim().length > 0) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const serverCode =
        (typeof data?.code === 'string' && data.code) ||
        (typeof data?.error?.code === 'string' && data.error.code) ||
        `HTTP_${response.status}`;
      const serverMessage =
        (typeof data?.error === 'string' && data.error) ||
        (typeof data?.error?.message === 'string' && data.error.message) ||
        (typeof data?.message === 'string' && data.message) ||
        (rawText.trim().length > 0 ? rawText.trim().slice(0, 300) : response.statusText);
      const safeMessage = sanitizeSecrets(serverMessage, secretsToRedact);
      throw new ToolExecutionError(serverCode, safeMessage, response.status);
    }

    return data ?? {};
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

  async function handleLogin(args) {
    const waitForApproval = args.wait_for_approval !== undefined ? Boolean(args.wait_for_approval) : true;
    const resumePending = args.resume_pending !== undefined ? Boolean(args.resume_pending) : false;
    const pollTimeoutMs = clamp(Number(args.poll_timeout_ms ?? 60_000) || 60_000, 500, 300_000);
    const pollIntervalMs = clamp(Number(args.poll_interval_ms ?? 1500) || 1500, 50, 30_000);

    const { origin: configuredOrigin } = await loadAuthContext();
    let targetOrigin = configuredOrigin;
    let deviceCode;
    let authorizeUrl;
    let userCode;

    if (resumePending) {
      const pending = await readJsonFileIfExists(pendingLoginPath);
      if (!pending || typeof pending.deviceCode !== 'string' || !pending.deviceCode) {
        throw new ToolExecutionError(
          'NO_PENDING_LOGIN',
          'No pending device login found. Call artifactboard_login({ resume_pending: false }) to start a new login.',
        );
      }
      targetOrigin = pending.origin
        ? validateAndNormalizeOrigin(pending.origin)
        : configuredOrigin;
      if (options.origin || process.env.ARTIFACTBOARD_ORIGIN) {
        if (targetOrigin !== configuredOrigin) {
          throw new ToolExecutionError(
            'ORIGIN_MISMATCH',
            `Pending login belongs to ${targetOrigin}, which does not match configured origin ${configuredOrigin}.`,
          );
        }
      }
      deviceCode = pending.deviceCode;
      authorizeUrl = pending.authorizeUrl;
      userCode = pending.userCode;
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
        !startData.authorizeUrl
      ) {
        throw new ToolExecutionError(
          'INVALID_SERVER_RESPONSE',
          'Device start response did not include deviceCode and authorizeUrl.',
        );
      }

      let parsedAuthUrl;
      try {
        parsedAuthUrl = new URL(startData.authorizeUrl);
      } catch {
        throw new ToolExecutionError('INVALID_AUTHORIZE_URL', 'Server returned a malformed authorizeUrl.');
      }
      if (parsedAuthUrl.origin !== new URL(targetOrigin).origin) {
        throw new ToolExecutionError(
          'ORIGIN_MISMATCH',
          'Refusing to open authorizeUrl because its origin does not match the ArtifactBoard origin.',
        );
      }

      deviceCode = startData.deviceCode;
      authorizeUrl = startData.authorizeUrl;
      userCode = startData.userCode;
      const expiresInSeconds = Number(startData.expiresIn) > 0 ? Number(startData.expiresIn) : 300;
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

      await writePrivateJsonFile(pendingLoginPath, {
        deviceCode,
        authorizeUrl,
        userCode,
        origin: targetOrigin,
        expiresAt,
      });

      const shouldOpenBrowser =
        args.open_browser !== undefined
          ? Boolean(args.open_browser)
          : process.env.ARTIFACTBOARD_NO_BROWSER !== '1';
      if (shouldOpenBrowser) {
        if (typeof options.openBrowser === 'function') {
          await Promise.resolve(options.openBrowser(authorizeUrl)).catch(() => {});
        } else {
          launchBrowserSafely(authorizeUrl);
        }
      }
    }

    if (!waitForApproval && !resumePending) {
      return {
        authenticated: false,
        status: 'pending',
        authorizeUrl,
        userCode,
        message: 'Approve in browser, then call artifactboard_login({ resume_pending: true })',
      };
    }

    const deadline = Date.now() + pollTimeoutMs;
    while (true) {
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
        if (typeof pollData.rawToken !== 'string' || !pollData.rawToken) {
          throw new ToolExecutionError(
            'INVALID_SERVER_RESPONSE',
            'Approved login response did not include an access token.',
          );
        }
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
        if (process.env.ARTIFACTBOARD_TOKEN) {
          loginResult.warning =
            'ARTIFACTBOARD_TOKEN is set in your environment and overrides the newly saved credentials file until unset.';
        }
        return loginResult;
      }

      if (pollData.status === 'expired') {
        await unlink(pendingLoginPath).catch(() => {});
        throw new ToolExecutionError(
          'LOGIN_EXPIRED',
          'Device login session expired before approval. Call artifactboard_login() to start a new login.',
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          authenticated: false,
          status: 'pending',
          authorizeUrl,
          userCode,
          message: 'Approve in browser, then call artifactboard_login({ resume_pending: true })',
        };
      }

      await delay(Math.min(pollIntervalMs, remaining));
    }
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
    };
    if (args.visibility !== undefined) {
      headers['X-Deck-Visibility'] = args.visibility;
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
    return {
      user: data.user,
      decks: data.decks ?? [],
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
