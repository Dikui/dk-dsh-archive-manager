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
const MAX_CANDIDATES = 120
const MAX_ARCHIVED_CANDIDATES = 40

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
    const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : ''
    const items = []
    for (const sessionId of ids) {
      const entry = store.get(sessionId)
      const header = recordById.get(sessionId)?.header
      const workspace = workspaceOf(sessionId, header?.cwd)
      const title = titleOf(titleResults, sessionId)
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
        restoredAt: entry?.restoredAt ?? null,
        history: entry?.history ?? [],
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
        source: entry?.source ?? null,
        restoredAt: entry?.restoredAt ?? null,
        history: entry?.history ?? [],
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
        restoredAt: saved.restoredAt ?? null,
        history: saved.history ?? [],
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
 * List sessions for the batch-archive candidate pool. Archived rows are shown
 * as context; only non-archived rows can be selected in the Client.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Promise<object>} _storePromise - Metadata store (unused).
 * @param {Request} request - Incoming request.
 * @returns {Promise<Response>} JSON candidate pool.
 */
async function handleCandidates(ctx, _storePromise, request) {
  const parsed = await readBody(request)
  if (parsed.response !== undefined) return parsed.response

  try {
    const [records, archived, workspaces] = await Promise.all([
      ctx.sessionQuery.listSessions(),
      archivedIds(ctx),
      safeList(() => ctx.workspaceRegistry.list()),
    ])
    const titleResults = await safeList(() => ctx.sessionQuery.readTitleSnapshots(
      records.map(record => String(record.header.id)).slice(0, 300),
    ))
    const archivedSet = new Set(archived)
    const workspaceOf = makeWorkspaceLookup(workspaces, new Map(records.map(record => [String(record.header.id), record])))
    const sorted = [...records].sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
    const open = sorted.filter(record => !archivedSet.has(String(record.header.id))).slice(0, MAX_CANDIDATES)
    const activities = await mapLimit(open, 4, record => probeActivity(ctx, String(record.header.id)))

    // Actionable (open) rows come first so a large archive set cannot crowd
    // out the sessions a batch archive can actually act on.
    const items = []
    for (let index = 0; index < open.length; index += 1) {
      items.push(candidateItem(open[index], false, activities[index], workspaceOf, titleResults))
    }
    items.push(...sorted
      .filter(record => archivedSet.has(String(record.header.id)))
      .slice(0, MAX_ARCHIVED_CANDIDATES)
      .map(record => candidateItem(record, true, [], workspaceOf, titleResults)))

    return json({
      ok: true,
      items,
      archivedCount: archivedSet.size,
      archivedSessionIds: archived,
      openCount: open.length,
    })
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: candidate list failed: %o', error)
    return json({ ok: false, reason: 'list-failed' }, 500)
  }
}

/**
 * Archive several sessions on explicit user request. Active sessions are never
 * stopped unless the Client sends both `stopActivity` and `confirmStop`; without
 * them the failure carries the activity details for a confirmation.
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
  const archived = []
  const failed = []
  for (const sessionId of unique) {
    if (archivedNow.has(sessionId)) {
      archived.push(sessionId)
      continue
    }
    userArchiving.add(sessionId)
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
      archived.push(sessionId)
      try {
        const store = await storePromise
        await store.put(sessionId, entryForArchive(sessionId, store.get(sessionId), Date.now(), 'user'))
      } catch (error) {
        ctx.logger?.warn?.('dk-dsh-archive-manager: could not record batch archive for %s: %o', sessionId, error)
      }
    } catch (error) {
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
  }

  return json({
    ok: failed.length === 0,
    archived,
    failed,
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
    return json({ ok: false, reason: 'save-failed' }, 500)
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
 * Build one candidate row.
 * @param {object} record - Session record.
 * @param {boolean} archived - Whether it is archived.
 * @param {object[]} activity - Activity details.
 * @param {(sessionId: string, cwd?: string) => object | undefined} workspaceOf - Workspace lookup.
 * @param {unknown} titleResults - Title snapshots.
 * @returns {object} Candidate row.
 */
function candidateItem(record, archived, activity, workspaceOf, titleResults) {
  const header = record?.header ?? {}
  const sessionId = String(header.id)
  const workspace = workspaceOf(sessionId, header.cwd)
  return {
    sessionId,
    title: titleOf(titleResults, sessionId),
    workspaceTitle: workspace?.title ?? (typeof header.cwd === 'string' ? basename(header.cwd) : null),
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : null,
    lastActivityAt: Number.isFinite(header.lastActivityAt) ? header.lastActivityAt : null,
    archived,
    active: activity.length > 0,
    activity,
  }
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
