/**
 * dsh-session-cleaner — delete a Session from inside dsh.
 *
 * The Harness has no Session delete: the sidebar offers archive only, and the
 * persistence service exposes `create/open/flush/stat/list`. Everything a row
 * needs is still ordinary files, so this plugin removes them and then tells the
 * Harness' own Session channel the row is gone — the same `api-session/removed`
 * event the Host emits for a disposed Session, which the client Session list
 * already consumes. No new event type, no client-side list surgery.
 *
 * What is removed, for one Session id `<id>`:
 *   - `<dsh home>/sessions/<workspace>/<id>/`      the Session log + its lease
 *   - `<dsh home>/storages/session_projcache/sessions/<id>.json`   sidebar cache
 *   - its registry bookkeeping (unpin / unarchive / detach from a Workspace)
 *
 * Deletion is a move into `<dsh home>/session-trash/` by default: a user pressing
 * the wrong row loses nothing, and a Session's log is not reproducible anywhere
 * else. `permanent: true` (or `config.permanent`) removes the directory outright.
 *
 * A Session that is still open in this Harness is refused by default: its log is
 * being appended to, so removing the directory would leave a half-written
 * session. The refusal names the reason, and `force: true` closes it instead —
 * cancel the turn, run the Session store's own detach lifecycle, and only then
 * move the directory (see {@link closeLiveSession}).
 *
 * Three surfaces share one implementation, per the user-actions contract:
 *   - Host routes under `config.basePath` (consumed by the client half),
 *   - the `session_cleaner_delete` / `session_cleaner_list` agent tools,
 *   - the sidebar Session menu item registered by `client.js`.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-session-cleaner'
export const inject = ['webServer']

/** Reported by `/health`, so a running Host can be told apart from a stale one. */
const PLUGIN_VERSION = '0.2.0'

/** Route prefix the client half fetches; `config.basePath` overrides it. */
const DEFAULT_BASE_PATH = '/dsh-session-cleaner'
/** A Session id is a directory name; this is the whole validation. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read a service without letting an undeclared read break start-up: a Cordis
 * context throws on a plain property read the plugin did not declare, while
 * `get` answers `undefined`.
 */
function serviceOf(ctx, key) {
  try {
    const get = ctx?.get
    return typeof get === 'function' ? get.call(ctx, key) : undefined
  } catch {
    return undefined
  }
}

/**
 * The directories one deletion touches, resolved at call time so a moved or
 * re-configured data home is picked up without a restart.
 */
function rootsOf(ctx) {
  const persistence = serviceOf(ctx, 'sessionPersistence')
  const reported = persistence && typeof persistence.root === 'string' ? persistence.root : null
  let sessions = reported === null ? null : path.resolve(reported)
  if (sessions === null) {
    const homePath = serviceOf(ctx, 'dshHomePath')
    if (typeof homePath === 'function') {
      try {
        sessions = path.resolve(homePath('sessions'))
      } catch {
        sessions = null
      }
    }
  }
  if (sessions === null || sessions === '') {
    const envHome = process.env.DSH_HOME
    const home = typeof envHome === 'string' && envHome !== '' ? path.resolve(envHome) : path.join(os.homedir(), '.dsh')
    sessions = path.join(home, 'sessions')
  }
  const home = path.dirname(sessions)
  return {
    home,
    sessions,
    projcache: path.join(home, 'storages', 'session_projcache', 'sessions'),
    trash: path.join(home, 'session-trash'),
  }
}

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function statOrNull(target) {
  try {
    return await fs.stat(target)
  } catch {
    return null
  }
}

async function isDirectory(target) {
  const stats = await statOrNull(target)
  return stats !== null && stats.isDirectory()
}

/** The Session's cached title and cwd, when the projection cache still has them. */
async function readRecord(roots, sessionId) {
  try {
    const raw = await fs.readFile(path.join(roots.projcache, `${sessionId}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    const record = parsed?.record ?? {}
    const title = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : null
    const cwd = typeof record?.identity?.cwd === 'string' ? record.identity.cwd : null
    return { title, cwd }
  } catch {
    return { title: null, cwd: null }
  }
}

/** `<sessions>/<workspace>/<session id>`; a direct child is accepted too. */
async function locateSession(roots, sessionId) {
  const direct = path.join(roots.sessions, sessionId)
  if (await isDirectory(direct)) return { dir: direct, workspaceDir: null }
  let entries
  try {
    entries = await fs.readdir(roots.sessions, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const candidate = path.join(roots.sessions, entry.name, sessionId)
    if (await isDirectory(candidate)) return { dir: candidate, workspaceDir: entry.name }
  }
  return null
}

/** Every Session on disk, newest first, capped at `limit`. */
async function listSessions(roots, limit) {
  const found = []
  let workspaceDirs
  try {
    workspaceDirs = await fs.readdir(roots.sessions, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const workspaceDir = path.join(roots.sessions, entry.name)
    let children
    try {
      children = await fs.readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith('session-')) continue
      const dir = path.join(workspaceDir, child.name)
      const stats = await statOrNull(dir)
      const meta = await readRecord(roots, child.name)
      found.push({
        sessionId: child.name,
        workspace: entry.name,
        dir,
        title: meta.title,
        cwd: meta.cwd,
        updatedAt: stats === null ? null : stats.mtimeMs,
      })
    }
  }
  found.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  return found.slice(0, limit)
}

/** Is this Session open in the running Harness right now? */
function liveSessionOf(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  const get = sessions?.get
  if (typeof get !== 'function') return null
  try {
    return get.call(sessions, sessionId) ?? null
  } catch {
    return null
  }
}

/** How long a running turn may take to stop before the Session is detached anyway. */
const TURN_STOP_GRACE_MS = 1500
/** How long the store may take to drop the entry once its detach lifecycle starts. */
const DETACH_TIMEOUT_MS = 4000
/** Let the persistence writer's final drain settle before its directory moves. */
const WRITER_SETTLE_MS = 80

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate() === true) return true
    if (Date.now() >= deadline) return false
    await delay(intervalMs)
  }
}

/**
 * Close one Session that this Harness still holds open, so its directory can be
 * moved away. Nothing here unlinks the log: a live Session is a store entry plus
 * a persistence writer holding the log handle, so the store's own detach
 * lifecycle is the only correct close.
 *
 * Order matters:
 *   1. cancel the Session's turn (bounded) — otherwise the loop keeps appending
 *      to a Session whose directory is about to leave, and the drag can resurrect
 *      a half-written log;
 *   2. call `sessions.remove(id)` — drops the entry, closes the writer, and emits
 *      `session/disposed`, which the API layer turns into `api-session/removed`
 *      (the sidebar row leaves every window on its own);
 *   3. wait until the entry is really gone, then give the writer's drain a beat.
 *
 * @returns whether the Session is closed afterwards.
 */
async function closeLiveSession(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents')
  const getAgent = agents?.get
  if (typeof getAgent === 'function') {
    let agent = null
    try {
      agent = getAgent.call(agents, sessionId) ?? null
    } catch {
      agent = null
    }
    if (agent !== null) {
      try {
        const cancel = agent.cancel
        if (typeof cancel === 'function') cancel.call(agent, { kind: 'user' })
      } catch {}
      try {
        const whenIdle = agent.whenIdle
        if (typeof whenIdle === 'function') {
          await Promise.race([Promise.resolve(whenIdle.call(agent)).catch(() => {}), delay(TURN_STOP_GRACE_MS)])
        }
      } catch {}
    }
  }

  const sessions = serviceOf(ctx, 'sessions')
  const remove = sessions?.remove
  if (typeof remove === 'function') {
    try {
      remove.call(sessions, sessionId)
    } catch {}
  } else if (liveSessionOf(ctx, sessionId) !== null) {
    // A store without the detach primitive cannot be closed from here; the caller
    // reports that instead of moving a directory out from under an open log.
    return false
  }

  if (liveSessionOf(ctx, sessionId) !== null) {
    const detached = await waitFor(() => liveSessionOf(ctx, sessionId) === null, DETACH_TIMEOUT_MS)
    if (!detached) return false
  }
  await delay(WRITER_SETTLE_MS)
  return true
}

/**
 * Drop the registry bookkeeping for a Session that is about to disappear: an
 * archived row would otherwise keep its id in the archive set, and a Workspace
 * would keep accounting an owner that no longer exists. Every step is
 * best-effort: the files are the truth, the registry is derived state.
 */
async function pruneRegistry(ctx, sessionId) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry === null || registry === undefined) return
  for (const method of ['unpinSession', 'unarchiveSession']) {
    const call = registry[method]
    if (typeof call !== 'function') continue
    try {
      await call.call(registry, sessionId)
    } catch {}
  }
  let workspaces = []
  try {
    workspaces = typeof registry.list === 'function' ? registry.list() : []
  } catch {
    workspaces = []
  }
  for (const workspace of workspaces) {
    const ids = workspace?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    const detach = workspace?.detachSession
    if (typeof detach !== 'function') continue
    try {
      await detach.call(workspace, sessionId)
    } catch {}
  }
}

/**
 * Remove one Session. Returns the facts a caller (and the UI) needs to say what
 * happened; throws a coded error when nothing was removed.
 */
async function deleteSession(ctx, roots, settings, request) {
  const raw = request?.sessionId
  const sessionId = typeof raw === 'string' ? raw.trim() : ''
  if (!ID_PATTERN.test(sessionId)) {
    throw coded('SESSION_ID_INVALID', `not a Session id: ${JSON.stringify(raw)}`)
  }
  const located = await locateSession(roots, sessionId)
  if (located === null) {
    throw coded('SESSION_NOT_FOUND', `no Session directory for ${sessionId} under ${roots.sessions}`)
  }
  const meta = await readRecord(roots, sessionId)
  const permanent = request?.permanent === true || settings.permanent === true
  let closed = false
  if (liveSessionOf(ctx, sessionId) !== null) {
    if (request?.force !== true) {
      throw coded(
        'SESSION_LIVE',
        `Session ${sessionId} is open in this Harness, so its log is still being written: switch to another Session (or close this window) and delete it again, or pass force to close it first`,
      )
    }
    closed = await closeLiveSession(ctx, sessionId)
    if (!closed) {
      throw coded(
        'SESSION_LIVE_UNCLOSED',
        `Session ${sessionId} is open in this Harness and would not close: a turn may still be finishing, so try again in a moment`,
      )
    }
  }
  const removed = []
  let trashPath = null

  await pruneRegistry(ctx, sessionId)

  if (permanent) {
    await fs.rm(located.dir, { recursive: true, force: true })
    removed.push(located.dir)
  } else {
    await fs.mkdir(roots.trash, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    trashPath = path.join(roots.trash, `${stamp}-${sessionId}`)
    try {
      await fs.rename(located.dir, trashPath)
    } catch (error) {
      // A cross-device move cannot rename; fall back to copy-then-remove so the
      // caller still gets the Session out of the sidebar.
      if (error?.code !== 'EXDEV') throw error
      await fs.cp(located.dir, trashPath, { recursive: true, force: true })
      await fs.rm(located.dir, { recursive: true, force: true })
    }
    removed.push(located.dir)
  }

  const cachePath = path.join(roots.projcache, `${sessionId}.json`)
  try {
    await fs.rm(cachePath, { force: true })
    removed.push(cachePath)
  } catch {}

  // The same event the Host emits for a disposed Session: the client Session
  // list drops the row, so no window keeps a row whose files are gone.
  try {
    const emit = ctx?.emit
    if (typeof emit === 'function') emit.call(ctx, 'api-session/removed', sessionId)
  } catch {}

  return {
    ok: true,
    sessionId,
    title: meta.title,
    cwd: meta.cwd,
    workspace: located.workspaceDir,
    mode: permanent ? 'permanent' : 'trash',
    trashPath,
    removed,
    closed,
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw coded('BODY_TOO_LARGE', 'request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw coded('BODY_INVALID', 'request body is not JSON')
  }
}

const STATUS_BY_CODE = {
  SESSION_ID_INVALID: 400,
  SESSION_LIVE: 409,
  SESSION_LIVE_UNCLOSED: 409,
  SESSION_NOT_FOUND: 404,
  BODY_INVALID: 400,
  BODY_TOO_LARGE: 413,
}

function failureOf(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } },
  }
}

/** The HTTP face: the client half fetches these, so they are the only transport. */
function routesOf(ctx, settings) {
  const base = settings.basePath
  const handler = async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://local')
    } catch (error) {
      const { status, body } = failureOf(error)
      return sendJson(res, status, body)
    }
    const action = url.pathname === base ? '' : url.pathname.slice(base.length).replace(/^\/+/, '').replace(/\/+$/, '')
    try {
      if (action === '' || action === 'health') {
        return sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-session-cleaner',
          version: PLUGIN_VERSION,
          basePath: base,
          routes: ['health', 'sessions', 'delete'],
        })
      }
      if (action === 'sessions') {
        const roots = rootsOf(ctx)
        const requested = Number(url.searchParams.get('limit') ?? '50')
        const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 50
        return sendJson(res, 200, { ok: true, sessions: await listSessions(roots, limit) })
      }
      if (action === 'delete') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } })
        const body = await readJsonBody(req)
        const roots = rootsOf(ctx)
        return sendJson(res, 200, await deleteSession(ctx, roots, settings, body))
      }
      return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown route ${url.pathname}` } })
    } catch (error) {
      const { status, body } = failureOf(error)
      return sendJson(res, status, body)
    }
  }
  return { kind: 'prefix', path: base, handler }
}

function toolText(text) {
  return [{ type: 'text', text }]
}

function registerTools(ctx, settings) {
  const tools = serviceOf(ctx, 'tools')
  const register = tools?.register
  if (typeof register !== 'function') return null
  const disposers = []

  disposers.push(
    register.call(tools, {
      name: 'session_cleaner_list',
      description:
        'List the dsh Sessions on disk, newest first, with their Session id, title, workspace and directory. Use it to find the Session id before session_cleaner_delete.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'how many Sessions to return (1-500, default 30)' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string' },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  updatedAt: { type: 'number' },
                },
                additionalProperties: true,
              },
            },
          },
          required: ['sessions'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const rows = Array.isArray(value?.sessions) ? value.sessions : []
          if (rows.length === 0) return toolText('没有找到会话')
          return toolText(
            rows
              .map((row) => `${row.sessionId} · ${row.title ?? '(无标题)'} · ${row.cwd ?? row.workspace ?? ''}`)
              .join('\n'),
          )
        },
      },
      execute: async (args) => {
        const roots = rootsOf(ctx)
        const requested = Number(args?.limit ?? 30)
        const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 30
        const sessions = await listSessions(roots, limit)
        return {
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            title: session.title ?? '',
            cwd: session.cwd ?? '',
            updatedAt: session.updatedAt ?? 0,
          })),
        }
      },
    }),
  )

  disposers.push(
    register.call(tools, {
      name: 'session_cleaner_delete',
      description:
        'Delete one dsh Session: removes its on-disk session directory (into the session trash by default, or permanently with permanent:true), clears its sidebar cache, and tells every open window the row is gone. A Session still open in this Harness is refused unless force:true is passed, which first closes it (cancelling any running turn) and then deletes it.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'the Session id, for example session-2f6f...-....' },
          permanent: { type: 'boolean', description: 'true skips the trash and deletes the directory immediately' },
          force: {
            type: 'boolean',
            description:
              'true closes the Session first when this Harness still has it open: a running turn is cancelled and its unfinished work is lost',
          },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            sessionId: { type: 'string' },
            title: { type: 'string' },
            mode: { type: 'string', enum: ['trash', 'permanent'] },
            trashPath: { type: 'string' },
            closed: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        presentationMeta: (_args, value) => ({ kind: 'session-cleaner', status: value?.ok === true ? 'deleted' : 'failed' }),
        render: (_args, value) => {
          if (value?.ok !== true) return toolText(`删除失败：${value?.message ?? 'unknown'}`)
          const where = value.mode === 'trash' ? `已移入回收站：${value.trashPath ?? ''}` : '已永久删除'
          const label = value.title ? `（${value.title}）` : ''
          const prefix = value.closed === true ? '已关闭该会话并删除' : '已删除会话'
          return toolText(`${prefix} ${value.sessionId}${label}\n${where}`)
        },
      },
      execute: async (args) => {
        const roots = rootsOf(ctx)
        try {
          return await deleteSession(ctx, roots, settings, args ?? {})
        } catch (error) {
          return { ok: false, sessionId: typeof args?.sessionId === 'string' ? args.sessionId : '', message: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {}
    }
  }
}

/** `config` comes from the patch layer and is not schema-checked here. */
function normalizeConfig(config) {
  const basePath =
    typeof config?.basePath === 'string' && config.basePath.startsWith('/') && !config.basePath.endsWith('/')
      ? config.basePath
      : DEFAULT_BASE_PATH
  return { basePath, permanent: config?.permanent === true }
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const server = serviceOf(ctx, 'webServer')
  if (server !== null && server !== undefined && typeof server.register === 'function') {
    ctx.effect(() => server.register(routesOf(ctx, settings)))
  }

  const disposeTools = registerTools(ctx, settings)
  if (disposeTools !== null) ctx.effect(() => disposeTools)
}
