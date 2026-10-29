// Offline verification of the Host half: a fake Cordis context, a throwaway
// DSH home, real files. No Harness, no user data. Runs on every CI platform so
// the rename/copy/remove paths are exercised on Windows and macOS too.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (condition, label, detail) => {
  if (condition) return
  failures.push(detail === undefined ? label : `${label}: ${detail}`)
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-cleaner-test-'))
const sessionsRoot = path.join(home, 'sessions')
const projcache = path.join(home, 'storages', 'session_projcache', 'sessions')
const workspace = '--tmp-demo--'
const plainId = 'session-11111111-2222-3333-4444-555555555555'
const liveId = 'session-99999999-8888-7777-6666-555555555555'
const keepId = 'session-77777777-6666-5555-4444-333333333333'

try {
  for (const sessionId of [plainId, liveId, keepId]) {
    await fs.mkdir(path.join(sessionsRoot, workspace, sessionId), { recursive: true })
    await fs.writeFile(path.join(sessionsRoot, workspace, sessionId, 'session.v4.jsonl.zstd'), 'log-bytes')
  }
  await fs.mkdir(projcache, { recursive: true })
  await fs.writeFile(
    path.join(projcache, `${plainId}.json`),
    JSON.stringify({ version: 7, record: { identity: { cwd: '/tmp/demo' }, rows: { title: { val: 'Demo row' } } } }),
  )

  const emitted = []
  const detached = []
  const registeredTools = []
  const live = new Map([[liveId, { id: liveId }]])
  const agent = { id: liveId, cancelled: null, cancel(cause) { this.cancelled = cause }, whenIdle: async () => {} }
  let exposeRemove = true
  let route = null

  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return { root: sessionsRoot }
      if (name === 'dshHomePath') return (...segments) => path.join(home, ...segments)
      if (name === 'sessions') {
        return {
          get: (id) => live.get(id) ?? null,
          ...(exposeRemove ? { remove: (id) => live.delete(id) } : {}),
        }
      }
      if (name === 'agents') return { get: (id) => (id === liveId ? agent : undefined) }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ sessionIds: [plainId], detachSession: async (id) => detached.push(id) }],
          unpinSession: async () => {},
          unarchiveSession: async () => {},
        }
      }
      if (name === 'tools') return { register: (definition) => { registeredTools.push(definition); return () => {} } }
      if (name === 'webServer') return { register: (candidate) => { route = candidate; return () => {} } }
      return undefined
    },
    emit: (event, payload) => emitted.push([event, payload]),
    effect: (fn) => fn(),
  }

  const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)
  plugin.apply(ctx, { basePath: '/dsh-session-cleaner' })
  check(route !== null, 'webServer route registered')
  check(route?.kind === 'prefix' && route?.path === '/dsh-session-cleaner', 'route is a prefix route')

  const call = async (url, method = 'GET', body) => {
    const chunks = []
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) { this.headers[key] = value },
      end(payload) { this.body = payload ?? '' },
    }
    await route.handler(req, res)
    let parsed = null
    try { parsed = JSON.parse(res.body) } catch {}
    return { status: res.statusCode, body: parsed }
  }

  const health = await call('/dsh-session-cleaner/health')
  check(health.status === 200 && health.body?.ok === true, 'health is ok', JSON.stringify(health.body))

  const list = await call('/dsh-session-cleaner/sessions')
  check(list.status === 200 && list.body.sessions.length === 3, 'lists every session on disk', list.body.sessions?.length)

  const invalid = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: '../../etc' })
  check(invalid.status === 400 && invalid.body.error.code === 'SESSION_ID_INVALID', 'rejects path traversal', invalid.body.error?.code)

  const missing = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: 'session-00000000-0000-0000-0000-000000000000' })
  check(missing.status === 404 && missing.body.error.code === 'SESSION_NOT_FOUND', 'reports an unknown session', missing.body.error?.code)

  const refused = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: liveId })
  check(refused.status === 409 && refused.body.error.code === 'SESSION_LIVE', 'refuses a live session', refused.body.error?.code)

  const closed = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: liveId, force: true })
  check(closed.status === 200 && closed.body.ok === true && closed.body.closed === true, 'force closes then deletes', JSON.stringify(closed.body))
  check(agent.cancelled?.kind === 'user', 'the running turn was cancelled', JSON.stringify(agent.cancelled))
  check(live.get(liveId) === undefined, 'the store dropped the session')

  const deleted = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: plainId })
  check(deleted.status === 200 && deleted.body.mode === 'trash', 'deletes into the trash', JSON.stringify(deleted.body))
  const trashEntries = await fs.readdir(path.join(home, 'session-trash')).catch(() => [])
  check(trashEntries.some((name) => name.endsWith(plainId)), 'the session directory is in the trash', trashEntries.join(','))
  check((await fs.stat(path.join(sessionsRoot, workspace, plainId)).catch(() => null)) === null, 'the source directory is gone')
  check((await fs.stat(path.join(projcache, `${plainId}.json`)).catch(() => null)) === null, 'the projection cache entry is gone')
  check(detached.includes(plainId), 'workspace bookkeeping was detached')
  check(
    emitted.some(([event, payload]) => event === 'api-session/removed' && payload === plainId),
    'api-session/removed was emitted',
  )

  const permanent = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: keepId, permanent: true })
  check(permanent.status === 200 && permanent.body.mode === 'permanent', 'permanent delete', JSON.stringify(permanent.body))
  check((await fs.stat(path.join(sessionsRoot, workspace, keepId)).catch(() => null)) === null, 'permanent delete removes the directory')

  check(registeredTools.length >= 2, 'agent tools registered', registeredTools.length)
  const deleteTool = registeredTools.find((tool) => tool.name === 'session_cleaner_delete')
  check(deleteTool !== undefined, 'session_cleaner_delete is registered')
  check(deleteTool?.parameters?.properties?.force?.type === 'boolean', 'the tool exposes force')
  check(deleteTool?.output?.schema !== undefined, 'the tool declares an output schema')

  // Without the store's detach primitive a live session must stay untouched.
  exposeRemove = false
  const stuckId = 'session-22222222-3333-4444-5555-666666666666'
  await fs.mkdir(path.join(sessionsRoot, workspace, stuckId), { recursive: true })
  live.set(stuckId, { id: stuckId })
  const stuck = await call('/dsh-session-cleaner/delete', 'POST', { sessionId: stuckId, force: true })
  check(stuck.status === 409 && stuck.body.error.code === 'SESSION_LIVE_UNCLOSED', 'refuses when it cannot close', stuck.body.error?.code)
  check((await fs.stat(path.join(sessionsRoot, workspace, stuckId)).catch(() => null)) !== null, 'a session it cannot close is left alone')

  if (failures.length > 0) {
    console.error(`✗ offline verification failed (${failures.length})`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
  } else {
    const toolText = deleteTool.output.render({ sessionId: plainId }, deleted.body).map((block) => block.text).join(' ')
    console.log(`✓ offline verification passed (${registeredTools.length} tools, trash + permanent + force-close paths)`)
    console.log(`  tool render: ${toolText.split('\n')[0]}`)
  }
} finally {
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5 })
}
