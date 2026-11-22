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
 * - `transcript` returns one bounded page of an archived session log.
 * - `candidates` / `archive-many` implement the confirmed batch archive pool.
 * - `views` / `view-save` / `view-delete` persist saved filters.
 * - `notice` supplies the archive timestamp for the built-in toast.
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
  clipText,
  entryForArchive,
  entryForRestore,
  mergeEntryPatch,
  normalizeView,
  PAUSED_SCHEDULES_MAX,
  summarizeEvents,
  summarizeList,
  transcriptPage,
  VIEWS_MAX,
  VIEW_NAME_MAX,
} from './src/model.js'
import { openStore } from './src/store.js'

/** Route prefix shared by the Host and Client. */
export const ROUTE_BASE = '/api/dk-dsh-archive-manager'

/** Largest request body accepted. Batch restore is the only large payload. */
const MAX_BODY_BYTES = 256 * 1024

/** Most sessions accepted in one batch operation. */
const MAX_BATCH = 200

/** Most non-archived sessions returned by the candidate pool. */
const MAX_CANDIDATES = 200
const MAX_ARCHIVED_CANDIDATES = 100

/** Age presets accepted by the batch workspace: sessions at least this old. */
const CANDIDATE_RANGES = new Map([
  ['older3d', 3 * 24 * 60 * 60 * 1000],
  ['older7d', 7 * 24 * 60 * 60 * 1000],
  ['older30d', 30 * 24 * 60 * 60 * 1000],
  ['older90d', 90 * 24 * 60 * 60 * 1000],
])

/** Which timestamp a batch time window applies to. */
const CANDIDATE_BASES = new Set(['activity', 'created'])

/** Which archive states the batch workspace may show. */
const CANDIDATE_STATES = new Set(['all', 'open', 'archived'])

/** Sort orders applied before the candidate cap. */
const CANDIDATE_SORTS = new Set(['active-asc', 'active-desc', 'created-desc'])

/** Host services this plugin requires. */
export const inject = [
  'connection',
  'sessionQuery',
  'sessionPersistence',
  'storageDomain',
  'workspaceController',
  'workspaceRegistry',
]

/** Default configuration: Agent retrieval stays off unless explicitly enabled. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dk-dsh-archive-manager',
    validate(value) {
      const record = value !== null && typeof value === 'object' ? value : {}
      if (record.tools !== undefined && typeof record.tools !== 'boolean') {
        return { issues: [{ message: 'tools must be a boolean', path: ['tools'] }] }
      }
      return { value: { tools: record.tools === true } }
    },
  },
}

/**
 * Register the archive-center routes, metadata store, and archive listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const storePromise = openStore(ctx)
  const ready = storePromise.catch(error => {
    ctx.logger?.warn?.('dk-dsh-archive-manager: metadata store failed to open: %o', error)
    throw error
  })
  const toolsEnabled = config?.tools === true
  /** Sessions currently being archived by an explicit user action. */
  const userArchiving = new Set()

  ctx.effect(() => () => {
    void ready.then(store => store.close()).catch(error => {
      ctx.logger?.warn?.('dk-dsh-archive-manager: metadata store close failed: %o', error)
    })
  }, 'dk-dsh-archive-manager: metadata store')

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('workspace/session-archived', payload => {
      const sessionId = payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (userArchiving.has(sessionId)) return
      void ready.then(async store => {
        const current = store.get(sessionId)
        await store.put(sessionId, entryForArchive(sessionId, current, Date.now(), 'plugin'))
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
    transcript: handleTranscript,
    candidates: handleCandidates,
    'archive-many': (host, store, request) => handleArchiveMany(host, store, request, userArchiving),
    views: handleViews,
    'view-save': handleViewSave,
    'view-delete': handleViewDelete,
    notice: handleNotice,
  }
  for (const [name, handler] of Object.entries(routes)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${ROUTE_BASE}/${name}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handler(ctx, ready, request),
    }), `dk-dsh-archive-manager: ${name} route`)
  }

  if (toolsEnabled) {
    if (typeof ctx.inject === 'function') {
      // Wait for the tools service instead of racing plugin load order. The
      // injected fiber is owned by this one and re-registers on service swaps.
      ctx.inject(['tools'], inner => registerTools(inner, inner.tools, ready))
    } else {
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
      registerTools(ctx, tools, ready)
    }
  }
}

/**
 * Register the optional tools when the service is present.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object | undefined} tools - Tools service.
 * @param {Promise<object>} ready - Metadata store.
 */
function registerTools(ctx, tools, ready) {
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return
  for (const tool of archiveTools(ctx, ready)) {
    ctx.effect(() => tools.register(tool), `dk-dsh-archive-manager: ${tool.name} tool`)
  }
}

/**
 * Build the optional read-only Agent tools. They are registered only when the
 * profile explicitly enables `tools`; outputs are bounded and never include a
 * complete transcript.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} ready - Metadata store.
 * @returns {object[]} Raw ToolDefinition values.
 */
function archiveTools(ctx, ready) {
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const output = { schema: { type: 'object', additionalProperties: true }, render }

  const listArchived = async (query, limit) => {
    const ids = await archivedIds(ctx)
    if (ids.length === 0) return []
    const [records, titleResults, workspaces, store] = await Promise.all([
      ctx.sessionQuery.listSessions(),
      safeList(() => ctx.sessionQuery.readTitleSnapshots(ids)),
      safeList(() => ctx.workspaceRegistry.list()),
      ready,
    ])
    const recordById = new Map(records.map(record => [String(record.header.id), record]))
    const workspaceOf = makeWorkspaceLookup(workspaces, recordById)
    const titleOfSession = titleLookup(titleResults)
    const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : ''
    const items = []
    for (const sessionId of ids) {
      const entry = store.get(sessionId)
      const header = recordById.get(sessionId)?.header
      const workspace = workspaceOf(sessionId, header?.cwd)
      const title = titleOfSession(sessionId)
      if (needle.length > 0) {
        const haystack = [sessionId, title, workspace?.title, entry?.note, ...(entry?.tags ?? [])]
          .filter(Boolean).join('\n').toLocaleLowerCase()
        if (!haystack.includes(needle)) continue
      }
      items.push({
        sessionId,
        title,
        workspace: workspace?.title ?? null,
        archivedAt: entry?.archivedAt ?? null,
        note: entry?.note ? clipText(entry.note, 500) : null,
        tags: entry?.tags ?? [],
      })
    }
    items.sort((a, b) => (b.archivedAt ?? -Infinity) - (a.archivedAt ?? -Infinity))
    return items.slice(0, limit)
  }

  return [
    {
      name: 'archive_list',
      description: 'List archived DSH sessions with metadata only. Read-only; does not return transcripts or restore anything. Use archive_read for a bounded transcript page.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive filter over title, workspace, note, tag, or id.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum rows (default 20).' },
        },
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const limit = Number.isInteger(args?.limit) ? Math.max(1, Math.min(args.limit, 50)) : 20
        const items = await listArchived(args?.query, limit)
        return { count: items.length, items }
      },
    },
    {
      name: 'archive_search',
      description: 'Search archived DSH sessions. Read-only; searches indexed events when available and returns short snippets, never full transcripts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Text to search for in archived sessions.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum rows (default 10).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query.length === 0) throw new Error('query must not be empty')
        const limit = Number.isInteger(args?.limit) ? Math.max(1, Math.min(args.limit, 20)) : 10
        const archived = new Set(await archivedIds(ctx))
        let items = []
        if (typeof ctx.sessionQuery.searchSessions === 'function') {
          try {
            const page = await ctx.sessionQuery.searchSessions({ query, limit })
            const hits = Array.isArray(page?.items) ? page.items : []
            items = hits
              .filter(hit => archived.has(String(hit?.header?.id ?? hit?.sessionId ?? hit?.id)))
              .slice(0, limit)
              .map(hit => {
                const sessionId = String(hit?.header?.id ?? hit?.sessionId ?? hit?.id)
                const snippet = hit?.bestMatch?.snippet ?? hit?.bestMatch?.text ?? ''
                return {
                  sessionId,
                  title: hit?.displayTitle ?? hit?.title ?? null,
                  snippet: clipText(typeof snippet === 'string' ? snippet : '', 240),
                }
              })
          } catch (error) {
            ctx.logger?.warn?.('dk-dsh-archive-manager: archive search fallback: %o', error)
          }
        }
        if (items.length === 0) items = await listArchived(query, limit)
        return { query, count: items.length, items }
      },
    },
    {
      name: 'archive_read',
      description: 'Read one bounded page of text from an archived DSH session. Read-only and limited to 20 events per call; use offset/nextOffset for pagination.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1, description: 'Archived session id from archive_list or archive_search.' },
          offset: { type: 'integer', minimum: 0, description: 'Zero-based event offset (default 0).' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Events per page (default 10).' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      output,
      async execute(args) {
        const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
        if (sessionId.length === 0) throw new Error('sessionId must not be empty')
        if (!(await archivedIds(ctx)).includes(sessionId)) throw new Error('session is not archived')
        const offset = Number.isInteger(args?.offset) ? Math.max(0, args.offset) : 0
        const limit = Number.isInteger(args?.limit) ? Math.max(1, Math.min(args.limit, 20)) : 10
        const [log, titleResults] = await Promise.all([
          ctx.sessionQuery.readSession(sessionId),
          safeList(() => ctx.sessionQuery.readTitleSnapshots([sessionId])),
        ])
        const page = transcriptPage(log.events, { offset, limit })
        return {
          sessionId,
          title: titleOf(titleResults, sessionId),
          eventCount: page.total,
          offset: page.offset,
          limit: page.limit,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          items: page.items,
        }
      },
    },
  ]
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
      safeList(() => ctx.sessionPersistence.list()),
      safeList(() => ctx.workspaceRegistry.list()),
      safeList(async () => ctx.sessionQuery.readTitleSnapshots(ids)),
    ])

    const recordById = new Map(records.map(record => [String(record.header.id), record]))
    const snapshotById = snapshotMap(ctx, snapshots)
    const workspaceOf = makeWorkspaceLookup(workspaces, recordById)
    const sizes = await mapLimit(ids, 8, sessionId => sizeInfo(snapshotById.get(sessionId)))
    const titleOfSession = titleLookup(titleResults)

    const items = ids.map((sessionId, index) => {
      const record = recordById.get(sessionId)
      const snapshot = snapshotById.get(sessionId)
      const header = record?.header ?? snapshot?.header
      const entry = store.get(sessionId)
      const workspace = workspaceOf(sessionId, header?.cwd)
      const size = sizes[index]
      return {
        ...sessionCore(sessionId, header, workspace, titleOfSession(sessionId)),
        workspaceId: workspace?.id ?? null,
        lastActivityAt: size.lastActivityAt,
        sizeBytes: size.sizeBytes,
        eventCount: Number.isFinite(snapshot?.eventCount) ? snapshot.eventCount : null,
        parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
        ghost: header === undefined,
        ...entryMeta(entry, true),
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
        ...sessionCore(sessionId, header, workspace, titleOf(titleResults, sessionId)),
        workspaceId: workspace?.id ?? null,
        lastActivityAt: size.lastActivityAt,
        sizeBytes: size.sizeBytes,
        eventCount: summary.eventCount,
        parentSession: typeof header?.parentSession === 'string' ? header.parentSession : null,
        ghost: false,
        ...entryMeta(entry, true),
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
      entry: entryMeta(saved),
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
    const archived = new Set(await archivedIds(ctx))
    const scheduleResumes = []
    await restoreArchivedSession(ctx, storePromise, sessionId, archived, scheduleResumes)
    return json({
      ok: true,
      restored: [sessionId],
      failed: [],
      scheduleResumes,
      archivedSessionIds: [...archived],
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
  const archived = new Set(await archivedIds(ctx))
  const restored = []
  const failed = []
  const scheduleResumes = []
  for (const sessionId of unique) {
    try {
      await restoreArchivedSession(ctx, storePromise, sessionId, archived, scheduleResumes)
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
    scheduleResumes,
    archivedSessionIds: [...archived],
  })
}

/**
 * Read one bounded page of a session log for the read-only transcript view.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} _storePromise - Metadata store (unused).
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON page.
 */
async function handleTranscript(ctx, _storePromise, request) {
  const parsed = await readSessionBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionId, body } = parsed
  const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0
  const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 100) : 40

  try {
    if (!(await archivedIds(ctx)).includes(sessionId)) {
      return json({ ok: false, reason: 'not-archived' }, 409)
    }
    const [log, titleResults] = await Promise.all([
      ctx.sessionQuery.readSession(sessionId),
      safeList(() => ctx.sessionQuery.readTitleSnapshots([sessionId])),
    ])
    return json({
      ok: true,
      transcript: {
        sessionId,
        title: titleOf(titleResults, sessionId),
        ...transcriptPage(log.events, { offset, limit }),
      },
    })
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_NOT_FOUND' || error?.name === 'SessionQueryNotFoundError') {
      return json({ ok: false, reason: 'not-found' }, 404)
    }
    ctx.logger?.warn?.('dk-dsh-archive-manager: transcript failed for %s: %o', sessionId, error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
}

/**
 * List sessions for the batch workspace. The optional `range`/`basis` pair
 * filters by a time window, and `state` narrows the result to open sessions,
 * archived sessions, or both. Archived rows are shown as context; only
 * non-archived rows can be archived and only archived rows can be restored.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} _storePromise - Metadata store (unused).
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON candidate pool.
 */
async function handleCandidates(ctx, _storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  const range = CANDIDATE_RANGES.has(parsed.body.range) ? parsed.body.range : 'all'
  const basis = CANDIDATE_BASES.has(parsed.body.basis) ? parsed.body.basis : 'activity'
  const state = CANDIDATE_STATES.has(parsed.body.state) ? parsed.body.state : 'all'
  const sort = CANDIDATE_SORTS.has(parsed.body.sort) ? parsed.body.sort : 'active-desc'

  try {
    // `locate` is synchronous and avoids a second full persistence scan;
    // `list` remains a fallback for backends that expose snapshot locations.
    const canLocate = typeof ctx.sessionPersistence?.locate === 'function'
    const [records, archived, pinned, workspaces, snapshots] = await Promise.all([
      ctx.sessionQuery.listSessions(),
      archivedIds(ctx),
      pinnedIds(ctx),
      safeList(() => ctx.workspaceRegistry.list()),
      canLocate ? [] : safeList(() => ctx.sessionPersistence.list()),
    ])
    const archivedSet = new Set(archived)
    const pinnedSet = new Set(pinned)
    // A pin is the user's keep-as-is signal, so pinned sessions stay out of the
    // batch pool entirely and no bulk action can archive one by accident.
    const unpinned = records.filter(record => !pinnedSet.has(String(record.header.id)))
    const workspaceOf = makeWorkspaceLookup(workspaces, new Map(records.map(record => [String(record.header.id), record])))
    const snapshotById = snapshotMap(ctx, snapshots)

    // Apply state before timestamps so a state-filtered request never stats
    // sessions it will not show.
    const inState = state === 'all' ? unpinned : unpinned.filter(record => {
      const isArchived = archivedSet.has(String(record.header.id))
      return state === 'open' ? !isArchived : isArchived
    })

    // Session headers carry no activity timestamp, so use the session log
    // mtime for activity filtering and activity sorting. Created-only sorting
    // is the one case that needs no stat calls.
    const needsActivity = basis === 'activity' || sort !== 'created-desc'
    const activityById = new Map()
    if (needsActivity) {
      const times = await mapLimit(inState, 8, record => lastActivityOf(
        ctx,
        record?.header,
        snapshotById.get(String(record?.header?.id)),
      ))
      inState.forEach((record, index) => {
        const id = String(record?.header?.id)
        if (times[index] !== null) activityById.set(id, times[index])
      })
    }

    const ageMs = CANDIDATE_RANGES.get(range) ?? null
    const cutoff = ageMs === null ? null : Date.now() - ageMs
    const createdTimeOf = record => Number.isFinite(record?.header?.createdAt)
      ? record.header.createdAt
      : null
    const activityTimeOf = record => {
      const header = record?.header ?? {}
      const active = activityById.get(String(header.id))
        ?? (Number.isFinite(header.lastActivityAt) ? header.lastActivityAt : null)
      return active ?? createdTimeOf(record)
    }
    const filterTimeOf = basis === 'created' ? createdTimeOf : activityTimeOf
    const matching = inState.filter(record => {
      if (cutoff !== null) {
        const time = filterTimeOf(record)
        if (time === null || time > cutoff) return false
      }
      return true
    })
    // Sort the whole matching set before slicing, so the cap keeps the rows
    // this order considers first. Grouping open before archived happens later.
    const byActivityAsc = (a, b) => (activityTimeOf(a) ?? 0) - (activityTimeOf(b) ?? 0)
      || (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0)
    const byActivityDesc = (a, b) => (activityTimeOf(b) ?? 0) - (activityTimeOf(a) ?? 0)
      || (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0)
    const byCreatedDesc = (a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0)
      || byActivityDesc(a, b)
    const comparator = sort === 'active-asc'
      ? byActivityAsc
      : sort === 'created-desc' ? byCreatedDesc : byActivityDesc
    matching.sort(comparator)
    const openAll = []
    const archivedAll = []
    for (const record of matching) {
      if (archivedSet.has(String(record.header.id))) archivedAll.push(record)
      else openAll.push(record)
    }
    const open = openAll.slice(0, MAX_CANDIDATES)
    const archivedRows = archivedAll.slice(0, MAX_ARCHIVED_CANDIDATES)

    // Filters run before titles so a very large history cannot crowd the
    // displayed rows out of the title snapshot batch.
    const displayed = [...open, ...archivedRows]
    const missingActivity = needsActivity ? [] : displayed.filter(record => !activityById.has(String(record?.header?.id)))
    const [titleResults, activities, missingTimes] = await Promise.all([
      safeList(() => ctx.sessionQuery.readTitleSnapshots(
        displayed.map(record => String(record.header.id)).slice(0, 300),
      )),
      mapLimit(open, 4, record => probeActivity(ctx, String(record.header.id))),
      mapLimit(missingActivity, 8, record => lastActivityOf(
        ctx,
        record?.header,
        snapshotById.get(String(record?.header?.id)),
      )),
    ])
    missingActivity.forEach((record, index) => {
      const id = String(record?.header?.id)
      if (missingTimes[index] !== null) activityById.set(id, missingTimes[index])
    })
    const titleOfSession = titleLookup(titleResults)

    // Actionable (open) rows come first so a large archive set cannot crowd
    // out the sessions a batch archive can actually act on.
    const items = []
    for (let index = 0; index < open.length; index += 1) {
      const record = open[index]
      items.push(candidateItem(
        record,
        false,
        activities[index],
        workspaceOf,
        titleOfSession,
        activityById.get(String(record.header.id)),
      ))
    }
    items.push(...archivedRows
      .map(record => candidateItem(
        record,
        true,
        [],
        workspaceOf,
        titleOfSession,
        activityById.get(String(record.header.id)),
      )))

    return json({
      ok: true,
      items,
      range,
      basis,
      state,
      sort,
      archivedCount: archivedSet.size,
      archivedSessionIds: archived,
      openCount: open.length,
      openTotal: openAll.length,
      archivedTotal: archivedAll.length,
      total: matching.length,
      truncatedOpen: openAll.length > open.length,
      truncatedArchived: archivedAll.length > archivedRows.length,
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: candidate list failed: %o', error)
    return json({ ok: false, reason: 'list-failed' }, 500)
  }
}

/**
 * Archive several sessions on explicit user request. Active sessions are never
 * stopped unless the Client sends both `stopActivity` and `confirmStop`; without
 * them the failure carries the activity details for a confirmation. A confirmed
 * stop pauses the scheduled tasks targeting each session first, because DSH's
 * archiving stop deletes them, and records them on the archive entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @param {Set<string>} userArchiving - Ids being written by this route.
 * @returns {Promise<Response>} JSON batch result.
 */
async function handleArchiveMany(ctx, storePromise, request, userArchiving) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  const { sessionIds } = parsed.body
  const stopActivity = parsed.body.stopActivity === true
  const confirmStop = parsed.body.confirmStop === true
  if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > MAX_BATCH
    || sessionIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }
  if (stopActivity && !confirmStop) {
    return json({ ok: false, reason: 'confirmation-required' }, 400)
  }

  const unique = [...new Set(sessionIds)]
  const archivedNow = new Set(await archivedIds(ctx))
  const schedule = scheduleService(ctx)
  const schedulePauses = []
  const archived = []
  const failed = []
  for (const sessionId of unique) {
    if (archivedNow.has(sessionId)) {
      archived.push(sessionId)
      continue
    }
    userArchiving.add(sessionId)
    let pause
    try {
      // DSH's archiving stop deletes every task that targets the session. A
      // confirmed stop pauses them first so the user can resume after restore.
      if (stopActivity) pause = await pauseSessionSchedules(ctx, schedule, sessionId)
      await ctx.workspaceRegistry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
      archived.push(sessionId)
      try {
        const store = await storePromise
        const entry = entryForArchive(
          sessionId,
          store.get(sessionId),
          Date.now(),
          'user',
          pause?.paused ?? [],
        )
        await store.put(sessionId, entry)
      } catch (error) {
        ctx.logger?.warn?.('dk-dsh-archive-manager: could not record batch archive for %s: %o', sessionId, error)
      }
    } catch (error) {
      if (pause !== undefined && pause.paused.length > 0) {
        const rolled = await resumeSessionSchedules(ctx, schedule, sessionId, pause.paused)
        if (rolled.failed.length > 0) {
          ctx.logger?.warn?.(
            'dk-dsh-archive-manager: archive failed and %d paused schedule(s) could not be resumed for %s',
            rolled.failed.length,
            sessionId,
          )
        }
      }
      if (error?.name === 'WorkspaceActiveSessionError') {
        failed.push({ sessionId, reason: 'active', activity: Array.isArray(error.activity) ? error.activity : [] })
      } else if (error?.code === 'SESSION_NOT_FOUND' || error?.name === 'SessionNotFoundError') {
        failed.push({ sessionId, reason: 'not-found' })
      } else {
        ctx.logger?.warn?.('dk-dsh-archive-manager: batch archive failed for %s: %o', sessionId, error)
        failed.push({ sessionId, reason: 'archive-failed' })
      }
    } finally {
      userArchiving.delete(sessionId)
    }
    if (pause !== undefined && (pause.paused.length > 0 || pause.failed.length > 0)) {
      schedulePauses.push({ sessionId, paused: pause.paused, failed: pause.failed })
    }
  }

  return json({
    ok: failed.length === 0,
    archived,
    failed,
    scheduleAvailable: schedule !== undefined,
    schedulePauses,
    archivedSessionIds: await archivedIds(ctx),
  })
}

/**
 * List saved views.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON views.
 */
async function handleViews(ctx, storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  try {
    const store = await storePromise
    const views = store.views().sort((a, b) => b.updatedAt - a.updatedAt)
    return json({ ok: true, views })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: view list failed: %o', error)
    return json({ ok: false, reason: 'list-failed' }, 500)
  }
}

/**
 * Create or update a saved view.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON saved view.
 */
async function handleViewSave(ctx, storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  const body = parsed.body
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }
  if (body.name.trim().length > VIEW_NAME_MAX) {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }

  try {
    const store = await storePromise
    const now = Date.now()
    const existing = typeof body.id === 'string' ? store.getView(body.id) : undefined
    if (existing === undefined && store.views().length >= VIEWS_MAX) {
      return json({ ok: false, reason: 'too-many-views' }, 409)
    }
    const id = existing?.id ?? `view-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const view = normalizeView(id, {
      name: body.name,
      query: body.query,
      filter: body.filter,
      sort: body.sort,
      tag: body.tag,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    if (view === undefined) return json({ ok: false, reason: 'invalid-request' }, 400)
    const saved = await store.putView(view)
    return json({ ok: true, view: saved })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: view save failed: %o', error)
    return json({ ok: false, reason: 'save-failed' }, 500)
  }
}

/**
 * Delete one saved view.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON result.
 */
async function handleViewDelete(ctx, storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response
  const id = parsed.body.id
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
    return json({ ok: false, reason: 'invalid-request' }, 400)
  }
  try {
    const store = await storePromise
    const deleted = await store.deleteView(id)
    return json({ ok: true, deleted })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: view delete failed: %o', error)
    return json({ ok: false, reason: 'delete-failed' }, 500)
  }
}

/**
 * Return the archive timestamp for the built-in archive notice. The route waits
 * briefly because the Host listener and the notice waterfall can race.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON notice facts.
 */
async function handleNotice(ctx, storePromise, request) {
  const parsed = await readSessionBody(request)
  if (parsed.response !== undefined) return parsed.response
  try {
    const store = await storePromise
    let entry = store.get(parsed.sessionId)
    // Wait out the archive-listener race, including a re-archive whose record
    // still carries the previous restore timestamp.
    for (let attempt = 0; attempt < 4 && (entry?.archivedAt === undefined || entry?.restoredAt !== undefined); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 40))
      entry = store.get(parsed.sessionId)
    }
    return json({
      ok: true,
      archivedAt: entry?.archivedAt ?? null,
      restoredAt: entry?.restoredAt ?? null,
      note: entry?.note ?? null,
      tags: entry?.tags ?? [],
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: notice lookup failed: %o', error)
    return json({ ok: false, reason: 'read-failed' }, 500)
  }
}

/**
 * Ask the activity waterfall, if any, whether a session is currently active.
 * No providers means "assume idle": the archive call itself still refuses.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - Session id.
 * @returns {Promise<object[]>} Activity list.
 */
async function probeActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const value = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/**
 * Build the session fields shared by list, preview, and candidate rows.
 * @param {string} sessionId - Session id.
 * @param {object | undefined} header - Session header.
 * @param {object | undefined} workspace - Owning workspace.
 * @param {string | null} title - Resolved title.
 * @returns {object} Shared session fields.
 */
function sessionCore(sessionId, header, workspace, title) {
  return {
    sessionId,
    title,
    workspaceTitle: workspace?.title ?? (typeof header?.cwd === 'string' ? basename(header.cwd) : null),
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
  }
}

/**
 * Build the sidecar metadata fields shared by list, preview, and entry saves.
 * @param {object | undefined} entry - Stored archive entry.
 * @param {boolean} [includeSource] - Include the archive source field.
 * @returns {object} Sidecar metadata.
 */
function entryMeta(entry, includeSource = false) {
  return {
    archivedAt: entry?.archivedAt ?? null,
    archivedAtKnown: entry?.archivedAt !== undefined,
    inferred: entry?.inferred ?? true,
    note: entry?.note ?? null,
    tags: entry?.tags ?? [],
    ...(includeSource ? { source: entry?.source ?? null } : {}),
    restoredAt: entry?.restoredAt ?? null,
    history: entry?.history ?? [],
  }
}

/**
 * Build one candidate row.
 * @param {object} record - Session record.
 * @param {boolean} archived - Whether it is archived.
 * @param {object[]} activity - Activity details.
 * @param {(sessionId: string, cwd?: string) => object | undefined} workspaceOf - Workspace lookup.
 * @param {(sessionId: string) => string | null} titleOfSession - Indexed title lookup.
 * @param {number | null | undefined} lastActivityAt - Log-derived activity time.
 * @returns {object} Candidate row.
 */
function candidateItem(record, archived, activity, workspaceOf, titleOfSession, lastActivityAt) {
  const header = record?.header ?? {}
  const sessionId = String(header.id)
  const workspace = workspaceOf(sessionId, header.cwd)
  return {
    ...sessionCore(sessionId, header, workspace, titleOfSession(sessionId)),
    lastActivityAt: Number.isFinite(lastActivityAt)
      ? lastActivityAt
      : (Number.isFinite(header.lastActivityAt) ? header.lastActivityAt : null),
    archived,
    active: activity.length > 0,
    activity,
  }
}

/**
 * Resolve the schedule service when the profile has one. Batch archiving is a
 * core feature, so a profile without the plugin degrades to DSH's own
 * delete-on-stop behaviour instead of failing the batch.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {object | undefined} Schedule service, or undefined when absent.
 */
function scheduleService(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('schedule') : ctx.schedule
    if (service === null || service === undefined) return undefined
    if (typeof service.catalog !== 'function' || typeof service.edit !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * Active tasks that deliver into one session. A `new` target creates a Session
 * per delivery, so it is never bound to the archived one.
 * @param {unknown} catalog - Task list from the schedule service.
 * @param {string} sessionId - Session being archived.
 * @returns {object[]} Matching tasks.
 */
function activeSessionTasks(catalog, sessionId) {
  return (Array.isArray(catalog) ? catalog : []).filter(task =>
    task?.status === 'active'
    && task?.target?.kind !== 'new'
    && task?.target?.sessionId === sessionId)
}

/**
 * Readable task name for a response, falling back to the id.
 * @param {object} task - Catalog entry.
 * @returns {string} Title or id.
 */
function scheduleTaskTitle(task) {
  if (typeof task?.title === 'string' && task.title.length > 0) return task.title
  return String(task?.id ?? '')
}

/**
 * Pause every active task targeting a session before DSH stops its activity.
 * An archiving stop deletes those rows, and a paused task survives the stop and
 * can be resumed after the session is restored. One failing task never blocks
 * the archive; it is reported to the caller instead.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object | undefined} schedule - Schedule service, when present.
 * @param {string} sessionId - Session being archived.
 * @returns {Promise<{ available: boolean, paused: { id: string, title: string }[], failed: object[] }>} Outcome.
 */
async function pauseSessionSchedules(ctx, schedule, sessionId) {
  const result = { available: schedule !== undefined, paused: [], failed: [] }
  if (schedule === undefined) return result
  let catalog
  try {
    catalog = await schedule.catalog()
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: schedule catalog failed for %s: %o', sessionId, error)
    return result
  }
  const matched = activeSessionTasks(catalog, sessionId)
  const tasks = matched.slice(0, PAUSED_SCHEDULES_MAX)
  for (const task of matched.slice(PAUSED_SCHEDULES_MAX)) {
    // Anything past the cap cannot be recorded on the entry, so it is reported
    // instead of being silently left for DSH's stop to delete.
    result.failed.push({ id: task.id, title: scheduleTaskTitle(task), reason: 'too-many' })
  }
  for (const task of tasks) {
    const title = scheduleTaskTitle(task)
    try {
      const outcome = await schedule.edit({ id: task.id, action: 'update', patch: { active: false } })
      if (typeof outcome?.code === 'string') {
        result.failed.push({ id: task.id, title, reason: outcome.code })
        continue
      }
      result.paused.push({ id: task.id, title })
    } catch (error) {
      ctx.logger?.warn?.('dk-dsh-archive-manager: could not pause schedule %s: %o', task.id, error)
      result.failed.push({ id: task.id, title, reason: 'pause-failed' })
    }
  }
  return result
}

/**
 * Resume the tasks this plugin paused. Runs after the session is unarchived:
 * resuming validates the target, and an archived target is refused.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object | undefined} schedule - Schedule service, when present.
 * @param {string} sessionId - Restored session.
 * @param {unknown} paused - Tasks recorded on the archive entry.
 * @returns {Promise<{ available: boolean, resumed: object[], failed: object[], skipped: object[] }>} Outcome.
 */
async function resumeSessionSchedules(ctx, schedule, sessionId, paused) {
  const result = { available: schedule !== undefined, resumed: [], failed: [], skipped: [] }
  const items = Array.isArray(paused) ? paused : []
  if (items.length === 0) return result
  if (schedule === undefined) {
    result.skipped = items.map(item => ({ id: item.id, title: item.title, reason: 'service-unavailable' }))
    return result
  }
  let catalog
  try {
    catalog = await schedule.catalog()
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: schedule catalog failed for %s: %o', sessionId, error)
    result.skipped = items.map(item => ({ id: item.id, title: item.title, reason: 'catalog-failed' }))
    return result
  }
  const byId = new Map((Array.isArray(catalog) ? catalog : []).map(task => [task?.id, task]))
  for (const item of items) {
    const task = byId.get(item.id)
    if (task === undefined) {
      result.skipped.push({ id: item.id, title: item.title, reason: 'missing' })
      continue
    }
    // Only tasks this plugin paused, still paused, and still bound to the
    // restored session are safe to touch; anything else belongs to the user.
    if (task.status !== 'paused') {
      result.skipped.push({ id: item.id, title: item.title, reason: 'not-paused' })
      continue
    }
    if (task?.target?.kind === 'new' || task?.target?.sessionId !== sessionId) {
      result.skipped.push({ id: item.id, title: item.title, reason: 'retargeted' })
      continue
    }
    try {
      const outcome = await schedule.edit({ id: task.id, action: 'update', patch: { active: true } })
      if (typeof outcome?.code === 'string') {
        result.failed.push({ id: task.id, title: item.title, reason: outcome.code })
        continue
      }
      result.resumed.push({ id: task.id, title: item.title })
    } catch (error) {
      ctx.logger?.warn?.('dk-dsh-archive-manager: could not resume schedule %s: %o', task.id, error)
      result.failed.push({ id: task.id, title: item.title, reason: 'resume-failed' })
    }
  }
  return result
}

/**
 * Read the paused-task list recorded on a session's archive entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {string} sessionId - Archived session.
 * @returns {Promise<{ id: string, title: string }[]>} Recorded tasks.
 */
async function pausedSchedulesOf(ctx, storePromise, sessionId) {
  try {
    const store = await storePromise
    const current = store.get(sessionId)
    return Array.isArray(current?.pausedSchedules) ? current.pausedSchedules : []
  } catch (error) {
    // A metadata failure must not block the restore; the tasks stay paused and
    // remain visible in Automation tasks.
    ctx.logger?.warn?.('dk-dsh-archive-manager: could not read paused schedules for %s: %o', sessionId, error)
    return []
  }
}

/**
 * Restore one archived session and keep the caller's archive set in sync.
 * Scheduled tasks this plugin paused are resumed after the unarchive, because
 * resuming validates the target Session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} storePromise - Metadata store.
 * @param {string} sessionId - Session to restore.
 * @param {Set<string>} archived - Archive set for the current response.
 * @param {object[]} [scheduleResumes] - Receives one outcome per restored session.
 * @returns {Promise<boolean>} Whether the session was in the archive set.
 */
async function restoreArchivedSession(ctx, storePromise, sessionId, archived, scheduleResumes) {
  if (!archived.has(sessionId)) return false
  const paused = await pausedSchedulesOf(ctx, storePromise, sessionId)
  await ctx.workspaceRegistry.unarchiveSession(sessionId)
  archived.delete(sessionId)
  if (paused.length > 0) {
    const outcome = await resumeSessionSchedules(ctx, scheduleService(ctx), sessionId, paused)
    if (scheduleResumes !== undefined) scheduleResumes.push({ sessionId, ...outcome })
  }
  await markRestored(ctx, storePromise, sessionId)
  return true
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
  return registrySessionIds(ctx, 'archivedSessionIds')
}

/**
 * The registry-global pin set, most recently pinned first.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<string[]>} Pinned session ids in pin order.
 */
async function pinnedIds(ctx) {
  return registrySessionIds(ctx, 'pinnedSessionIds')
}

/**
 * Read one registry-global session id set. The direct getter is preferred;
 * `workspaceController.follow` covers a future surface that hides it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {'archivedSessionIds' | 'pinnedSessionIds'} key - Registry field.
 * @returns {Promise<string[]>} Session ids in registry order.
 */
async function registrySessionIds(ctx, key) {
  try {
    const direct = ctx.workspaceRegistry?.[key]
    if (Array.isArray(direct)) return direct.map(String)
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: %s getter unavailable: %o', key, error)
  }
  const controller = ctx.workspaceController
  if (controller !== undefined && typeof controller.follow === 'function') {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 1500)
    try {
      for await (const frame of controller.follow(abort.signal)) {
        if (frame?.type === 'baseline' || frame?.type === 'replace') {
          const ids = frame.value?.[key]
          if (Array.isArray(ids)) return ids.map(String)
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('dk-dsh-archive-manager: %s stream unavailable: %o', key, error)
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }
  return []
}

/**
 * Resolve title text from one `readTitleSnapshots` result.
 * @param {unknown} result - Per-session title result.
 * @returns {string | null} Title, or null when unavailable.
 */
function titleValueOf(result) {
  const value = result?.value?.title
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (value !== null && typeof value === 'object' && typeof value.title === 'string' && value.title.trim().length > 0) {
    return value.title.trim()
  }
  return null
}

/**
 * Index title results once so list rendering is not quadratic in sessions.
 * @param {unknown} results - Per-session title results.
 * @returns {(sessionId: string) => string | null} Title lookup.
 */
function titleLookup(results) {
  if (!Array.isArray(results)) return () => null
  const byId = new Map()
  for (const result of results) {
    const id = String(result?.sessionId)
    if (!byId.has(id)) byId.set(id, titleValueOf(result))
  }
  return sessionId => byId.get(String(sessionId)) ?? null
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
  return titleValueOf(result)
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
 * Index persistence snapshots by session id. Some DSH persistence versions
 * return bare headers from `list()`; attach the located artifact path so size
 * and activity facts still work.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object[]} snapshots - Snapshot or header objects.
 * @returns {Map<string, object>} Snapshot by session id.
 */
function snapshotMap(ctx, snapshots) {
  const byId = new Map()
  for (const snapshot of snapshots) {
    if (snapshot === null || typeof snapshot !== 'object') continue
    const header = snapshot.header ?? snapshot
    const id = header?.id
    if (typeof id !== 'string') continue
    if (snapshot.header !== undefined) {
      byId.set(id, snapshot)
      continue
    }
    const normalized = { header }
    try {
      const location = ctx.sessionPersistence?.locate?.(header)
      if (location !== undefined) normalized.location = location
    } catch { /* no located artifact */ }
    byId.set(id, normalized)
  }
  return byId
}

/**
 * Last write time of a session log. Session headers have no activity field, so
 * the persistence artifact's mtime is the cheapest truthful activity source.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {object | undefined} header - Session header.
 * @param {object | undefined} snapshot - Persistence snapshot, if available.
 * @returns {Promise<number | null>} Epoch milliseconds, or null if unknown.
 */
async function lastActivityOf(ctx, header, snapshot) {
  let path = snapshot?.location?.path
  if (typeof path !== 'string' || path.length === 0) {
    try {
      path = ctx.sessionPersistence?.locate?.(header)?.path
    } catch {
      path = undefined
    }
  }
  if (typeof path !== 'string' || path.length === 0) return null
  try {
    const info = await stat(path)
    return info.isFile() ? info.mtimeMs : null
  } catch {
    return null
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
