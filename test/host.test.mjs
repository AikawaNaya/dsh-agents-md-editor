/**
 * Offline verification of the Host half: mounts the plugin on a stub Context,
 * captures its route, and exercises state / save / conflict / fence against a
 * throwaway file under the OS temp directory. It never touches the real
 * `~/.dsh/AGENTS.md`.
 *
 *     node test/host.test.mjs
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** Minimal `ServerResponse`: records the status, headers, and body. */
function mockRes() {
  const out = { status: 0, headers: null, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = typeof body === 'string' ? body : ''
    },
  }
}

/** Invoke the route handler with a synthetic request and parse its JSON reply. */
async function call(handler, { method = 'GET', url, body }) {
  const req = (async function* () {
    if (body !== undefined) yield Buffer.from(body, 'utf8')
  })()
  req.method = method
  req.url = url
  req.headers = {}
  const res = mockRes()
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.out.body)
  } catch {
    json = null
  }
  return { status: res.out.status, json, raw: res.out.body }
}

/** Mount the plugin once and hand back its captured route. */
function mount(filePath, { deny = () => false } = {}) {
  const routes = []
  apply(
    {
      effect: (fn) => fn(),
      webServer: { register: (route) => (routes.push(route), () => {}) },
      connection: { requestRejection: () => (deny() ? { reason: 'untrusted' } : undefined) },
      logger: { info() {}, warn() {} },
    },
    { filePath },
  )
  return routes[0]
}

const dir = await mkdtemp(join(tmpdir(), 'ame-host-'))
const target = join(dir, 'AGENTS.md')

let denial = false
const route = mount(target, { deny: () => denial })

check('one route registered', route !== undefined, route && `${route.kind} ${route.path}`)
check('route is a prefix route', route.kind === 'prefix' && route.path === '/agents-md-editor/api')

// 1. Missing file reads as an empty, unsaved buffer.
let out = await call(route.handler, { url: '/agents-md-editor/api/state' })
check('GET state on missing file → 200 exists:false', out.status === 200 && out.json.value.exists === false)
check('missing file has null version', out.json.value.version === null)

// 2. The first save creates the file.
const first = '# hello\n\nfirst body\n'
out = await call(route.handler, {
  method: 'POST',
  url: '/agents-md-editor/api/save',
  body: JSON.stringify({ content: first, baseVersion: null }),
})
const v1 = out.json?.value?.version
check('POST save creates file → 200', out.status === 200 && typeof v1 === 'string')
check('sha1 version matches content', v1 === createHash('sha1').update(first, 'utf8').digest('hex'))
check('bytes reached disk', (await readFile(target, 'utf8')) === first)
check('savedAt is a timestamp', typeof out.json.value.savedAt === 'number' && out.json.value.savedAt > 0)
check('size matches stat', out.json.value.size === (await stat(target)).size)

// 3. State reports the same content and version afterwards.
out = await call(route.handler, { url: '/agents-md-editor/api/state' })
check(
  'GET state → exists, content, version',
  out.json.value.exists === true && out.json.value.content === first && out.json.value.version === v1,
)
check('state path is the resolved target', out.json.value.path === target)

// 4. A save based on the current version succeeds.
const second = first + 'second line\n'
out = await call(route.handler, {
  method: 'POST',
  url: '/agents-md-editor/api/save',
  body: JSON.stringify({ content: second, baseVersion: v1 }),
})
const v2 = out.json?.value?.version
check('POST save with current baseVersion → 200', out.status === 200 && typeof v2 === 'string')
check('file rewritten', (await readFile(target, 'utf8')) === second)

// 5. A stale base version is refused and the file is left alone.
out = await call(route.handler, {
  method: 'POST',
  url: '/agents-md-editor/api/save',
  body: JSON.stringify({ content: 'CLOBBERED', baseVersion: v1 }),
})
check('POST save with stale baseVersion → 409 conflict', out.status === 409 && out.json.error.code === 'conflict')
check('conflict left the file intact', (await readFile(target, 'utf8')) === second)

// 6. Method and route errors.
out = await call(route.handler, { method: 'POST', url: '/agents-md-editor/api/state', body: '{}' })
check('POST state → 405', out.status === 405)
out = await call(route.handler, { url: '/agents-md-editor/api/nope' })
check('unknown action → 404', out.status === 404 && out.json.error.code === 'not-found')
out = await call(route.handler, { method: 'POST', url: '/agents-md-editor/api/save', body: 'not json' })
check('malformed JSON → 400', out.status === 400)
out = await call(route.handler, {
  method: 'POST',
  url: '/agents-md-editor/api/save',
  body: JSON.stringify({ baseVersion: v2 }),
})
check('missing content → 400', out.status === 400)

// 7. The browser-trust fence answers 403 before any file work.
denial = true
out = await call(route.handler, { url: '/agents-md-editor/api/state' })
check('untrusted request → 403', out.status === 403 && out.json.error.code === 'forbidden')
denial = false

// 8. Path resolution: `~` expands, and the default lands under .dsh.
const tilde = mount('~/.dsh/AGENTS.md')
out = await call(tilde.handler, { url: '/agents-md-editor/api/state' })
const expectedHome = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'AGENTS.md')
check('`~` expands to the home directory', out.json.value.path === expectedHome, out.json.value.path)
check('default target resolves under .dsh', out.json.value.path.replace(/\\/g, '/').endsWith('.dsh/AGENTS.md'))

const failed = results.filter((result) => !result.ok)
await rm(dir, { recursive: true, force: true })
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
