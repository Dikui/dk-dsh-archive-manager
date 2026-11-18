/**
 * Host half of dk-dsh-archive-manager.
 *
 * DSH's built-in archive is a registry-global set of session ids with no
 * timestamp, note, tag, preview, or bulk surface. This plugin adds a read-only
 * archive center over the same set and keeps its own sidecar metadata:
 *
 * - `list` enumerates the archive set, joins session headers, titles, sizes,
 *   and sidecar metadata, and returns the archive-center view.
 * - `preview` reads one archived session log through `sessionQuery` without
 *   unarchiving or resuming it.
 * - `entry` saves a note and tags for one archived session.
 * - `unarchive` / `unarchive-many` restore sessions through the registry.
 *
 * It never deletes a session, never deletes a workspace, and never stops
 * activity silently. All routes are same-origin JSON POSTs with a no-store
 * response.
 *
 * @module dk-dsh-archive-manager
 */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  entryForArchive,
  entryForRestore,
  mergeEntryPatch,
  summarizeEvents,
  summarizeList,
} from './src/model.js'
import { openStore } from './src/store.js'

/** Route prefix shared by the Host and Client. */
export const ROUTE_BASE = '/api/dk-dsh-archive-manager'

/** Largest request body accepted. Batch restore is the only large payload. */
const MAX_BODY_BYTES = 256 * 1024

/** Most sessions accepted in one batch restore. */
const MAX_BATCH = 200

/** Host services this plugin requires. */
export const inject = [
  'connection',
  'sessionQuery',
  'sessionPersistence',
  'storageDomain',
  'workspaceController',
  'workspaceRegistry',
]

/**
 * Register the archive-center routes, metadata store, and archive listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {void}
 */
export function apply(ctx) {
  const storePromise = openStore(ctx)
  const ready = storePromise.catch(error => {
    ctx.logger?.warn?.('dk-dsh-archive-manager: metadata store failed to open: %o', error)
    throw error
  })

  ctx.effect(() => () => {
    void ready.then(store => store.close()).catch(error => {
      ctx.logger?.warn?.('dk-dsh-archive-manager: metadata store close failed: %o', error)
    })
  }, 'dk-dsh-archive-manager: metadata store')

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('workspace/session-archived', payload => {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      void ready.then(async store => {
        const current = store.get(sessionId)
        await store.put(sessionId, entryForArchive(sessionId, current, Date.now()))
      }).catch(error => {
        ctx.logger?.warn?.('dk-dsh-archive-manager: could not record archive time for %s: %o', sessionId, error)
      })
    }), 'dk-dsh-archive-manager: archive listener')
  }

  const routes = {
    list: handleList,
    preview: handlePreview,
    entry: handleEntry,
    unarchive: handleUnarchive,
    'unarchive-many': handleUnarchiveMany,
  }
  for (const [name, handler] of Object.entries(routes)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE_BASE}/${name}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handler(ctx, ready, request),
    }), `dk-dsh-archive-manager: ${name} route`)
  }
}

/**
 * List every archived session with sidecar metadata and capacity facts.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON list.
 */
async function handleList(ctx, storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response

  try {
    const store = await storePromise
    const ids = await archivedIds(ctx)
    if (ids.length === 0) {
      return json({ ok: true, summary: summarizeList([]), items: [] })
    }

    const [records, snapshots, workspaces, titleResults] = await Promise.all([
      ctx.sessionQuery.listSessions(),
      ctx.sessionPersistence.list(),
      safeList(() => ctx.workspaceRegistry.list()),
      safeList(async () => ctx.sessionQuery.readTitleSnapshots(ids)),
    ])

    const recordById = new Map(records.map(record => [String(record.header.id), record]))
    const snapshotById = new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot]))
    const workspaceOf = makeWorkspaceLookup(workspaces, recordById)
    const sizes = await mapLimit(ids, 8, sessionId => sizeInfo(snapshotById.get(sessionId)))

    const items = ids.map((sessionId, index) => {
      const record = recordById.get(sessionId)
      const snapshot = snapshotById.get(sessionId)
      const header = record?.header ?? snapshot?.header
      const entry = store.get(sessionId)
      const workspace = workspaceOf(sessionId, header?.cwd)
      const size = sizes[index]
      return {
        sessionId,
        title: titleOf(titleResults, sessionId),
        workspaceId: workspace?.id ?? null,
        workspaceTitle: workspace?.title ?? (typeof header?.cwd === 'string' ? basename(header.cwd) : null),
        cwd: typeof header?.cwd === 'string' ? header.cwd : null,
        createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
        lastActivityAt: size.lastActivityAt,
        sizeBytes: size.sizeBytes,
        eventCount: Number.isFinite(snapshot?.eventCount) ? snapshot.eventCount : null,
        parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
        ghost: header === undefined,
        archivedAt: entry?.archivedAt ?? null,
        archivedAtKnown: entry?.archivedAt !== undefined,
        inferred: entry?.inferred ?? true,
        note: entry?.note ?? null,
        tags: entry?.tags ?? [],
        source: entry?.source ?? null,
      }
    })

    items.sort((a, b) => (b.archivedAt ?? -Infinity) - (a.archivedAt ?? -Infinity)
      || (b.createdAt ?? 0) - (a.createdAt ?? 0))

    return json({
      ok: true,
      summary: summarizeList(items),
      items,
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: list failed: %o', error)
    return json({ ok: false, reason: 'list-failed' }, 500)
  }
}

/**
 * Read one archived session and return a compact, read-only preview.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON preview.
 */
async function handlePreview(ctx, storePromise, request) {
  const parsed = await readSessionBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionId } = parsed

  try {
    if (!(await archivedIds(ctx)).includes(sessionId)) {
      return json({ ok: false, reason: 'not-archived' }, 409)
    }
    const store = await storePromise
    const [log, snapshot, titleResults, workspaces] = await Promise.all([
      ctx.sessionQuery.readSession(sessionId),
      safeValue(() => ctx.sessionPersistence.stat(sessionId)),
      safeList(() => ctx.sessionQuery.readTitleSnapshots([sessionId])),
      safeList(() => ctx.workspaceRegistry.list()),
    ])
    const header = log.session ?? snapshot?.header
    const workspace = makeWorkspaceLookup(workspaces, new Map())(sessionId, header?.cwd)
    const entry = store.get(sessionId)
    const size = await sizeInfo(snapshot)
    const summary = summarizeEvents(log.events)

    return json({
      ok: true,
      preview: {
        sessionId,
        title: titleOf(titleResults, sessionId),
        workspaceId: workspace?.id ?? null,
        workspaceTitle: workspace?.title ?? (typeof header?.cwd === 'string' ? basename(header.cwd) : null),
        cwd: typeof header?.cwd === 'string' ? header.cwd : null,
        createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
        lastActivityAt: size.lastActivityAt,
        sizeBytes: size.sizeBytes,
        eventCount: summary.eventCount,
        parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
        ghost: false,
        archivedAt: entry?.archivedAt ?? null,
        archivedAtKnown: entry?.archivedAt !== undefined,
        inferred: entry?.inferred ?? true,
        note: entry?.note ?? null,
        tags: entry?.tags ?? [],
        ...summary,
      },
    })
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_NOT_FOUND' || error?.name === 'SessionQueryNotFoundError') {
      return json({ ok: false, reason: 'not-found' }, 404)
    }
    ctx.logger?.warn?.('dk-dsh-archive-manager: preview failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
}

/**
 * Save note/tags for one archived session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON entry.
 */
async function handleEntry(ctx, storePromise, request) {
  const parsed = await readSessionBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionId, body } = parsed

  const hasNote = Object.prototype.hasOwnProperty.call(body, 'note')
  const hasTags = Object.prototype.hasOwnProperty.call(body, 'tags')
  if (!hasNote && !hasTags) return json({ ok: false, reason: 'invalid-request' }, 400)
  if (hasNote && body.note !== null && typeof body.note !== 'string') {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }
  if (hasTags && !Array.isArray(body.tags) && typeof body.tags !== 'string') {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }

  try {
    if (!(await archivedIds(ctx)).includes(sessionId)) {
      return json({ ok: false, reason: 'not-archived' }, 409)
    }
    const store = await storePromise
    const current = store.get(sessionId)
    const patch = {}
    if (hasNote) patch.note = body.note
    if (hasTags) patch.tags = body.tags
    const next = mergeEntryPatch(sessionId, current, patch)
    const saved = await store.put(sessionId, next)
    return json({
      ok: true,
      entry: {
        archivedAt: saved.archivedAt ?? null,
        archivedAtKnown: saved.archivedAt !== undefined,
        inferred: saved.inferred,
        note: saved.note ?? null,
        tags: saved.tags,
      },
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: entry save failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'save-failed' }, 500)
  }
}

/**
 * Restore one session from the archive.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON restore result.
 */
async function handleUnarchive(ctx, storePromise, request) {
  const parsed = await readSessionBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionId } = parsed

  try {
    if (!(await archivedIds(ctx)).includes(sessionId)) {
      return json({ ok: true, restored: [sessionId], failed: [], archivedSessionIds: await archivedIds(ctx) })
    }
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
    await markRestored(ctx, storePromise, sessionId)
    return json({
      ok: true,
      restored: [sessionId],
      failed: [],
      archivedSessionIds: await archivedIds(ctx),
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: unarchive failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'unarchive-failed', failed: [{ sessionId, reason: 'unarchive-failed' }] }, 409)
  }
}

/**
 * Restore several sessions. Each item settles independently; a partial result
 * is reported instead of rolling back successful restores.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON batch result.
 */
async function handleUnarchiveMany(ctx, storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionIds } = parsed.body
  if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > MAX_BATCH
    || sessionIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }

  const unique = [...new Set(sessionIds)]
  const restored = []
  const failed = []
  for (const sessionId of unique) {
    try {
      if ((await archivedIds(ctx)).includes(sessionId)) {
        await ctx.workspaceRegistry.unarchiveSession(sessionId)
        await markRestored(ctx, storePromise, sessionId)
      }
      restored.push(sessionId)
    } catch (error) {
      ctx.logger?.warn?.('dk-dsh-archive-manager: batch unarchive failed for %s: %o', sessionId, error)
      failed.push({ sessionId, reason: 'unarchive-failed' })
    }
  }
  return json({
    ok: failed.length === 0,
    restored,
    failed,
    archivedSessionIds: await archivedIds(ctx),
  })
}

/**
 * Persist the restore timestamp without dropping note/tags.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {string} sessionId - Restored session.
 * @returns {Promise<void>} Resolves after the metadata write.
 */
async function markRestored(ctx, storePromise, sessionId) {
  try {
    const store = await storePromise
    const current = store.get(sessionId)
    if (current === undefined) return
    await store.put(sessionId, entryForRestore(sessionId, current, Date.now()))
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: could not record restore time for %s: %o', sessionId, error)
  }
}

/**
 * The registry-global archive set. The getter is public on the registry even
 * though the Host Service catalog lists methods only; `follow` remains a
 * fallback for a future surface that hides the getter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<string[]>} Archived session ids in archive order.
 */
async function archivedIds(ctx) {
  try {
    const direct = ctx.workspaceRegistry?.archivedSessionIds
    if (Array.isArray(direct)) return direct.map(String)
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: archive getter unavailable: %o', error)
  }
  const controller = ctx.workspaceController
  if (controller !== undefined && typeof controller.follow === 'function') {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 1500)
    try {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame?.type === 'baseline' || frame?.type === 'replace') {
          const ids = frame.value?.archivedSessionIds
          if (Array.isArray(ids)) return ids.map(String)
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('dk-dsh-archive-manager: archive stream unavailable: %o', error)
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
  return []
}

/**
 * Resolve title text from `readTitleSnapshots` results.
 * @param {unknown} results - Per-session title results.
 * @param {string} sessionId - Session id.
 * @returns {string | null} Title, or null when unavailable.
 */
function titleOf(results, sessionId) {
  if (!Array.isArray(results)) return null
  const result = results.find(item => String(item?.sessionId) === sessionId)
  const value = result?.value?.title
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (value !== null && typeof value === 'object' && typeof value.title === 'string' && value.title.trim().length > 0) {
    return value.title.trim()
  }
  return null
}

/**
 * Build a lookup that prefers explicit workspace membership, then exact cwd.
 * @param {readonly object[]} workspaces - Registry workspaces.
 * @param {Map<string, object>} records - Session records by id.
 * @returns {(sessionId: string, cwd?: string) => object | undefined} Lookup.
 */
function makeWorkspaceLookup(workspaces, records) {
  const bySession = new Map()
  const byPath = new Map()
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace === null || typeof workspace !== 'object') continue
    if (typeof workspace.path === 'string') byPath.set(workspace.path.replace(/\/+$/, '') || '/', workspace)
    if (Array.isArray(workspace.sessionIds)) {
      for (const sessionId of workspace.sessionIds) bySession.set(String(sessionId), workspace)
    }
  }
  return (sessionId, cwd) => {
    const byId = bySession.get(sessionId)
    if (byId !== undefined) return byId
    const known = records.get(sessionId)
    const path = typeof cwd === 'string' ? cwd : known?.header?.cwd
    if (typeof path !== 'string') return undefined
    return byPath.get(path.replace(/\/+$/, '') || '/')
  }
}

/**
 * Cheap size/activity facts for one persisted session.
 * @param {object | undefined} snapshot - Persistence snapshot.
 * @returns {Promise<{ sizeBytes: number | null, lastActivityAt: number | null }>} Facts.
 */
async function sizeInfo(snapshot) {
  if (snapshot === undefined) return { sizeBytes: null, lastActivityAt: null }
  let sizeBytes = Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : null
  let lastActivityAt = null
  const path = snapshot.location?.path
  if (typeof path === 'string' && path.length > 0) {
    try {
      const info = await stat(path)
      if (info.isFile()) {
        if (sizeBytes === null) sizeBytes = info.size
        lastActivityAt = info.mtimeMs
      }
    } catch { /* a missing/expired log is shown without size */ }
  }
  return { sizeBytes, lastActivityAt }
}

/**
 * Run async work over a list with bounded concurrency.
 * @template T, R
 * @param {readonly T[]} items - Inputs.
 * @param {number} limit - Maximum parallel workers.
 * @param {(item: T) => Promise<R>} worker - Work item.
 * @returns {Promise<R[]>} Results in input order.
 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return out
}

/**
 * Resolve an optional list without letting one missing service empty the view.
 * @param {() => Promise<unknown[]> | unknown[]} read - Reader.
 * @returns {Promise<unknown[]>} List or an empty list.
 */
async function safeList(read) {
  try {
    const value = await read()
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/**
 * Resolve an optional single value.
 * @param {() => Promise<unknown>} read - Reader.
 * @returns {Promise<unknown>} Value or undefined.
 */
async function safeValue(read) {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * Validate the shared POST envelope.
 * @param {Request} request - Incoming request.
 * @returns {Promise<{ body?: Record<string, unknown>, response?: Response }>} Body or early response.
 */
async function readBody(request) {
  if (request.method !== 'POST') return { response: json({ ok: false, reason: 'method-not-allowed' }, 405) }
  if (!isSameOriginJson(request)) return { response: json({ ok: false, reason: 'forbidden' }, 403) }
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return { response: json({ ok: false, reason: 'body-too-large' }, 413) }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { body }
}

/**
 * Validate a request carrying one session id.
 * @param {Request} request - Incoming request.
 * @returns {Promise<{ sessionId?: string, body?: Record<string, unknown>, response?: Response }>} Parsed request.
 */
async function readSessionBody(request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return { response: parsed.response }
  const sessionId = parsed.body.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    return { response: json({ ok: false, reason: 'invalid-request' }, 400) }
  }
  return { sessionId, body: parsed.body }
}

/**
 * Reject non-JSON and cross-authority mutations.
 * @param {Request} request - Incoming request.
 * @returns {boolean} Whether the request may reach a handler.
 */
function isSameOriginJson(request) {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return false
  if (request.headers.get('x-dk-archive-manager') !== '1') return false
  const origin = request.headers.get('origin')
  if (origin === null) return true
  try {
    const source = new URL(origin)
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin) return false
    const host = request.headers.get('host') ?? new URL(request.url).host
    return new URL(`${source.protocol}//${host}`).host === source.host
  } catch {
    return false
  }
}

/**
 * Serialize a no-store JSON response.
 * @param {unknown} body - Payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} JSON response.
 */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
