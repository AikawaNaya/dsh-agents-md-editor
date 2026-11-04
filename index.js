/**
 * Host half of `dsh-agents-md-editor`.
 *
 * Owns exactly one file — the target resolved from the plugin row's
 * `config.filePath` (default `~/.dsh/AGENTS.md`) — and serves two fenced
 * routes for the Client half:
 *
 *   GET  /agents-md-editor/api/state   → { exists, path, content, version, mtimeMs, size }
 *   POST /agents-md-editor/api/save    → { path, version, mtimeMs, size, savedAt } | conflict
 *
 * `version` is the sha1 of the file's UTF-8 bytes. The Client sends the
 * version it loaded as `baseVersion`; a mismatch is reported as `conflict`
 * (HTTP 409) instead of silently overwriting somebody else's edit, and the
 * Client then offers to reload the on-disk text.
 *
 * Every route is gated by the Host's own browser-trust policy
 * (`ctx.connection.requestRejection`), the same fence the shipped plugins use.
 * The plugin never touches any other path: the route table takes no user
 * supplied path, and `filePath` comes from the profile patch the user owns.
 *
 * Writes go straight through `node:fs`, not the file sandbox, because the
 * target deliberately lives outside the session workspace (`~/.dsh`) and a
 * UI action has no approval channel to raise. The blast radius is one file.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Services this plugin cannot work without. */
export const inject = ['webServer', 'connection']

/** Route namespace owned by this plugin. */
const ROUTE = '/agents-md-editor/api'

/** Default target when the row carries no `filePath`. */
const DEFAULT_FILE = '~/.dsh/AGENTS.md'

/** Upper bound on one save request body. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** A failure with a wire code and a matching HTTP status. */
class EditorError extends Error {
  /**
   * @param {string} code - Stable wire code (`bad-request`, `conflict`, ...).
   * @param {string} message - Human-readable reason.
   * @param {number} status - HTTP status the route answers with.
   */
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Expand `~` and make the configured target absolute.
 * @param {unknown} raw - Raw `config.filePath`.
 * @returns {string} Absolute path of the one file this plugin edits.
 */
function resolveFileTarget(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_FILE
  let expanded = value
  if (value === '~') expanded = homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) expanded = join(homedir(), value.slice(2))
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded)
}

/**
 * Content version: sha1 of the exact UTF-8 bytes the editor shows.
 * @param {string} content - File text.
 * @returns {string} 40 hex characters.
 */
function versionOf(content) {
  return createHash('sha1').update(content, 'utf8').digest('hex')
}

/**
 * Read the target, treating a missing file as an empty, unsaved editor buffer.
 * @param {string} file - Absolute target path.
 * @returns {Promise<{ exists: boolean, content: string, version: string | null, mtimeMs: number | null, size: number }>}
 */
async function readTarget(file) {
  try {
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { exists: true, content, version: versionOf(content), mtimeMs: info.mtimeMs, size: info.size }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, content: '', version: null, mtimeMs: null, size: 0 }
    }
    throw error
  }
}

/**
 * Replace the target atomically: write a sibling temp file, then rename over
 * the target. A crash mid-write leaves the previous content intact instead of
 * a truncated file, which matters because this file is the model's standing
 * instructions.
 * @param {string} file - Absolute target path.
 * @param {string} content - New file text.
 * @returns {Promise<{ version: string, mtimeMs: number, size: number }>}
 */
async function writeTarget(file, content) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  const info = await stat(file)
  return { version: versionOf(content), mtimeMs: info.mtimeMs, size: info.size }
}

/**
 * Buffer a request body, refusing oversized payloads without exhausting memory.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @returns {Promise<unknown>} Parsed JSON, or undefined for an empty body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new EditorError('too-large', 'request body is too large', 413)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new EditorError('bad-request', 'request body is not valid JSON', 400)
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Build the route handler for one fixed target file.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} file - Absolute target path resolved at activation.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function createHandler(ctx, file) {
  return async (req, res) => {
    if (ctx.connection.requestRejection(req) !== undefined) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const action = url.pathname.startsWith(`${ROUTE}/`) ? url.pathname.slice(ROUTE.length + 1) : ''
    try {
      if (action === 'state') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new EditorError('method-error', 'use GET', 405)
        }
        const state = await readTarget(file)
        sendJson(res, 200, { ok: true, value: { ...state, path: file } })
        return
      }
      if (action === 'save') {
        if (req.method !== 'POST') throw new EditorError('method-error', 'use POST', 405)
        const body = await readJsonBody(req)
        const content = body !== null && typeof body === 'object' ? body.content : undefined
        if (typeof content !== 'string') throw new EditorError('bad-request', 'content must be a string', 400)
        const baseVersionRaw = body !== null && typeof body === 'object' ? body.baseVersion : undefined
        const baseVersion = typeof baseVersionRaw === 'string' ? baseVersionRaw : null
        const current = await readTarget(file)
        if (baseVersion !== current.version) {
          throw new EditorError('conflict', 'the file changed on disk since it was loaded', 409)
        }
        const saved = await writeTarget(file, content)
        ctx.logger?.info?.(`dsh-agents-md-editor: saved ${file} (${saved.size} bytes)`)
        sendJson(res, 200, { ok: true, value: { ...saved, path: file, savedAt: Date.now() } })
        return
      }
      throw new EditorError('not-found', `unknown method "${action}"`, 404)
    } catch (error) {
      if (error instanceof EditorError) {
        sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      ctx.logger?.warn?.(`dsh-agents-md-editor: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : 'internal error' },
      })
    }
  }
}

/**
 * Mount the fenced route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{ filePath?: string }} [config] - The row's config.
 */
export function apply(ctx, config) {
  const file = resolveFileTarget(config?.filePath)
  ctx.logger?.info?.(`dsh-agents-md-editor: editing ${file}`)
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler(ctx, file) }),
    'dsh-agents-md-editor: /agents-md-editor/api route',
  )
}
