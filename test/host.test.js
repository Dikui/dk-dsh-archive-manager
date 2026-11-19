import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ROUTE_BASE, apply } from '../index.js'

const SESSION_ID = 'session-11111111-1111-4111-8111-111111111111'
const GHOST_ID = 'session-22222222-2222-4222-8222-222222222222'
const ACTIVE_ID = 'session-33333333-3333-4333-8333-333333333333'

function header(id, overrides = {}) {
  return {
    version: 4,
    id,
    createdAt: 1_700_000_000_000,
    cwd: '/tmp/archive-workspace',
    isSeeded: false,
    ...overrides,
  }
}

function snapshot(id) {
  return {
    header: header(id),
    revision: 3,
    eventCount: 12,
    sizeBytes: 2048,
    location: { kind: 'file', path: `/tmp/${id}.jsonl` },
  }
}

function makeHarness({ getter = true, tools = false, config, listHeaders = false, snapshots = [snapshot(SESSION_ID)] } = {}) {
  const routes = new Map()
  const listeners = new Map()
  const archived = new Set([SESSION_ID, GHOST_ID])
  const entries = new Map()
  const registeredTools = new Map()
  const archiveCalls = []

  const workspace = {
    id: 'workspace-1',
    title: 'archive-workspace',
    path: '/tmp/archive-workspace',
    sessionIds: [SESSION_ID],
  }

  const ctx = {
    logger: { warn() {} },
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route.fetch)
          return () => routes.delete(route.path)
        },
      },
    },
    workspaceRegistry: {
      list() {
        return [workspace]
      },
      async archiveSession(id, options) {
        archiveCalls.push({ id, options })
        if (id === ACTIVE_ID && options?.stopActivity !== true) {
          const error = new Error('session is active')
          error.name = 'WorkspaceActiveSessionError'
          error.sessionId = id
          error.activity = [{ kind: 'turn', items: [{ id: 'turn-1', label: 'Running turn' }] }]
          throw error
        }
        archived.add(id)
      },
      async unarchiveSession(id) {
        archived.delete(id)
      },
    },
    async waterfall(name, payload, fallback) {
      if (name === 'workspace/session-activity' && payload?.sessionId === ACTIVE_ID) {
        return [{ kind: 'turn', items: [{ id: 'turn-1', label: 'Running turn' }] }]
      }
      return typeof fallback === 'function' ? fallback() : undefined
    },
    workspaceController: {
      async *follow() {
        yield {
          type: 'baseline',
          value: { items: [], archivedSessionIds: [...archived], pinnedSessionIds: [] },
        }
      },
    },
    sessionQuery: {
      listSessions() {
        return [{
          header: header(SESSION_ID),
          live: false,
          persisted: true,
          formatStatus: 'ok',
        }, {
          header: header(ACTIVE_ID, { createdAt: 1_700_000_000_500, lastActivityAt: 1_700_000_009_000 }),
          live: true,
          persisted: true,
          formatStatus: 'ok',
        }]
      },
      readTitleSnapshots(ids) {
        return ids.map(sessionId => sessionId === SESSION_ID
          ? {
              sessionId,
              status: 'fulfilled',
              value: {
                session: header(sessionId),
                title: {
                  title: 'Archived design notes',
                  messageSeqs: [1],
                  source: 'first-prompt',
                  eventSeq: 1,
                  updatedAt: 1_700_000_000_100,
                },
              },
            }
          : sessionId === ACTIVE_ID
            ? {
                sessionId,
                status: 'fulfilled',
                value: {
                  session: header(sessionId),
                  title: {
                    title: 'Active coding',
                    messageSeqs: [1],
                    source: 'first-prompt',
                    eventSeq: 1,
                    updatedAt: 1_700_000_000_600,
                  },
                },
              }
            : { sessionId, status: 'rejected', reason: 'missing' })
      },
      readSession(id) {
        if (id !== SESSION_ID) {
          const error = new Error('not found')
          error.code = 'SESSION_QUERY_NOT_FOUND'
          throw error
        }
        return {
          session: header(id),
          inheritedEventCount: 0,
          events: [
            { type: 'turn/start', seq: 1, time: 1_700_000_001_000, data: { turn: 1 } },
            { type: 'step/start', seq: 2, time: 1_700_000_001_100, data: { turn: 1, step: 1 } },
            { type: 'user/message', seq: 3, time: 1_700_000_001_200, data: { role: 'user', content: [{ type: 'text', text: 'Please archive this' }] } },
            { type: 'tool/call', seq: 4, time: 1_700_000_001_300, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: {} } },
            { type: 'assistant/message', seq: 5, time: 1_700_000_001_400, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Archived.' }] } } },
          ],
        }
      },
    },
    sessionPersistence: {
      list() {
        return listHeaders ? [header(SESSION_ID)] : snapshots
      },
      locate(meta) {
        const found = snapshots.find(item => (item.header?.id ?? item.id) === meta.id)
        return found?.location ?? { kind: 'file', path: `/tmp/${meta.id}.jsonl` }
      },
      stat(id) {
        return id === SESSION_ID ? snapshot(id) : undefined
      },
    },
    storageDomain: undefined,
    tools: tools
      ? {
          register(tool) {
            registeredTools.set(tool.name, tool)
            return () => registeredTools.delete(tool.name)
          },
        }
      : undefined,
  }

  if (getter) {
    Object.defineProperty(ctx.workspaceRegistry, 'archivedSessionIds', {
      get: () => [...archived],
    })
  }

  apply(ctx, config ?? {})
  return { ctx, routes, listeners, archived, entries, registeredTools, archiveCalls }
}

async function withHome(run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dkam-host-'))
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

async function post(routes, name, body, overrides = {}) {
  const route = routes.get(`${ROUTE_BASE}/${name}`)
  assert.equal(typeof route, 'function', `route ${name} should be registered`)
  const request = new Request(`http://127.0.0.1:55740${ROUTE_BASE}/${name}`, {
    method: overrides.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dk-archive-manager': '1',
      ...(overrides.headers ?? {}),
    },
    body: overrides.rawBody ?? JSON.stringify(body ?? {}),
  })
  return route(request)
}

test('registers every POST route', () => {
  const { routes } = makeHarness()
  for (const name of [
    'list',
    'preview',
    'entry',
    'unarchive',
    'unarchive-many',
    'transcript',
    'candidates',
    'archive-many',
    'views',
    'view-save',
    'view-delete',
    'notice',
  ]) {
    assert.ok(routes.has(`${ROUTE_BASE}/${name}`), name)
  }
})

test('list joins archive set, title, size, workspace, and metadata', async () => {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dkam-host-'))
  process.env.DSH_HOME = home
  try {
    const { routes } = makeHarness()
    const response = await post(routes, 'list', {})
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.items.length, 2)
    const item = body.items.find(entry => entry.sessionId === SESSION_ID)
    assert.equal(item.title, 'Archived design notes')
    assert.equal(item.workspaceId, 'workspace-1')
    assert.equal(item.sizeBytes, 2048)
    assert.equal(item.eventCount, 12)
    assert.equal(item.ghost, false)
    const ghost = body.items.find(entry => entry.sessionId === GHOST_ID)
    assert.equal(ghost.ghost, true)
    assert.equal(body.summary.count, 2)
    assert.equal(body.summary.totalSize, 2048)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('list tolerates persistence backends that return bare headers', async () => {
  const { routes } = makeHarness({ listHeaders: true })
  const response = await post(routes, 'list', {})
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(body.items.some(item => item.sessionId === SESSION_ID))
})

test('falls back to the controller baseline when the registry getter is hidden', async () => {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dkam-host-'))
  process.env.DSH_HOME = home
  try {
    const { routes } = makeHarness({ getter: false })
    const response = await post(routes, 'list', {})
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.items.length, 2)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('preview returns a read-only projection without unarchiving', async () => {
  const { routes, archived } = makeHarness()
  const response = await post(routes, 'preview', { sessionId: SESSION_ID })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.preview.title, 'Archived design notes')
  assert.equal(body.preview.turns, 1)
  assert.equal(body.preview.steps, 1)
  assert.equal(body.preview.toolCalls, 1)
  assert.equal(body.preview.firstUserText, 'Please archive this')
  assert.equal(body.preview.lastAssistantText, 'Archived.')
  assert.equal(body.preview.topTools[0].name, 'read')
  assert.equal(archived.has(SESSION_ID), true, 'preview must not unarchive')
})

test('preview rejects a session outside the archive set', async () => {
  const { routes } = makeHarness()
  const response = await post(routes, 'preview', { sessionId: 'session-not-archived' })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).reason, 'not-archived')
})

test('entry saves note and tags, then list reflects them', async () => {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'dkam-host-'))
  process.env.DSH_HOME = home
  try {
    const { routes } = makeHarness()
    const saved = await post(routes, 'entry', {
      sessionId: SESSION_ID,
      note: '  revisit after launch  ',
      tags: 'design, preview, design',
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody.entry.note, 'revisit after launch')
    assert.deepEqual(savedBody.entry.tags, ['design', 'preview'])

    const listed = await post(routes, 'list', {})
    const body = await listed.json()
    const item = body.items.find(entry => entry.sessionId === SESSION_ID)
    assert.equal(item.note, 'revisit after launch')
    assert.deepEqual(item.tags, ['design', 'preview'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('unarchive removes one id without touching metadata', async () => {
  const { routes, archived } = makeHarness()
  const response = await post(routes, 'unarchive', { sessionId: SESSION_ID })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.restored, [SESSION_ID])
  assert.equal(archived.has(SESSION_ID), false)
})

test('unarchive-many settles each id and reports partial failures', async () => {
  const { routes, archived } = makeHarness()
  const response = await post(routes, 'unarchive-many', { sessionIds: [SESSION_ID, GHOST_ID] })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.restored, [SESSION_ID, GHOST_ID])
  assert.deepEqual(body.failed, [])
  assert.equal(archived.size, 0)
  assert.deepEqual(body.archivedSessionIds, [])
})

test('rejects cross-origin, wrong content type, and oversized batches', async () => {
  const { routes } = makeHarness()
  const cross = await post(routes, 'list', {}, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(cross.status, 403)

  const wrongType = await post(routes, 'list', {}, {
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.status, 403)

  const tooMany = await post(routes, 'unarchive-many', {
    sessionIds: Array.from({ length: 201 }, (_, index) => `session-${index}`),
  })
  assert.equal(tooMany.status, 400)
})

test('transcript returns bounded pages without unarchiving', async () => {
  const { routes, archived } = makeHarness()
  const response = await post(routes, 'transcript', { sessionId: SESSION_ID, offset: 1, limit: 2 })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.transcript.total, 5)
  assert.equal(body.transcript.items.length, 2)
  assert.equal(body.transcript.items[0].index, 1)
  assert.equal(body.transcript.items[0].type, 'step/start')
  assert.equal(body.transcript.hasMore, true)
  assert.equal(body.transcript.nextOffset, 3)
  assert.equal(archived.has(SESSION_ID), true)

  const missing = await post(routes, 'transcript', { sessionId: ACTIVE_ID })
  assert.equal(missing.status, 409)
  assert.equal((await missing.json()).reason, 'not-archived')
})

test('candidates mark active sessions and list archived ones separately', async () => {
  const { routes } = makeHarness()
  const response = await post(routes, 'candidates', {})
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.openCount, 1)
  assert.equal(body.archivedCount, 2)
  const active = body.items.find(item => item.sessionId === ACTIVE_ID)
  assert.equal(active.archived, false)
  assert.equal(active.active, true)
  assert.equal(active.activity[0].kind, 'turn')
  const archived = body.items.find(item => item.sessionId === SESSION_ID)
  assert.equal(archived.archived, true)
  assert.equal(archived.active, false)
})

test('candidates apply time range, basis, and state filters', async () => {
  const { routes } = makeHarness()

  const openOnly = await (await post(routes, 'candidates', { state: 'open' })).json()
  assert.equal(openOnly.state, 'open')
  assert.equal(openOnly.openTotal, 1)
  assert.equal(openOnly.archivedTotal, 0)
  assert.equal(openOnly.total, 1)
  assert.deepEqual(openOnly.items.map(item => item.sessionId), [ACTIVE_ID])

  const archivedOnly = await (await post(routes, 'candidates', { state: 'archived' })).json()
  assert.equal(archivedOnly.archivedTotal, 1)
  assert.equal(archivedOnly.openTotal, 0)
  assert.deepEqual(archivedOnly.items.map(item => item.sessionId), [SESSION_ID])

  const allTime = await (await post(routes, 'candidates', { range: 'all' })).json()
  assert.equal(allTime.total, 2)
  assert.equal(allTime.truncatedOpen, false)
  assert.equal(allTime.truncatedArchived, false)

  // Fixture sessions were created in 2023, so they are older than any preset.
  const older = await (await post(routes, 'candidates', { range: 'older7d', basis: 'activity' })).json()
  assert.equal(older.range, 'older7d')
  assert.equal(older.total, 2)
  assert.deepEqual(older.items.map(item => item.sessionId), [ACTIVE_ID, SESSION_ID])

  const fallback = await (await post(routes, 'candidates', {
    range: 'nope',
    basis: 'nope',
    state: 'nope',
    sort: 'nope',
  })).json()
  assert.equal(fallback.range, 'all')
  assert.equal(fallback.basis, 'activity')
  assert.equal(fallback.state, 'all')
  assert.equal(fallback.sort, 'active-desc')
})

test('candidates exclude sessions newer than the preset and sort before the cap', async () => {
  const { routes, ctx } = makeHarness()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const records = [
    { id: 'session-old', createdAt: now - 40 * day, lastActivityAt: now - 2 * day },
    { id: 'session-mid', createdAt: now - 10 * day, lastActivityAt: now - 20 * day },
    { id: 'session-new', createdAt: now - 1 * day, lastActivityAt: now - 30 * day },
  ]
  ctx.sessionQuery.listSessions = () => records.map(record => ({
    header: header(record.id, { createdAt: record.createdAt, lastActivityAt: record.lastActivityAt }),
    live: false,
    persisted: true,
    formatStatus: 'ok',
  }))

  const byActivity = await (await post(routes, 'candidates', {
    range: 'older7d', basis: 'activity', state: 'open', sort: 'active-asc',
  })).json()
  // session-old was active 2 days ago, so "older than 7 days" must exclude it.
  assert.deepEqual(byActivity.items.map(item => item.sessionId), ['session-new', 'session-mid'])

  const recentFirst = await (await post(routes, 'candidates', {
    range: 'older7d', basis: 'activity', state: 'open', sort: 'active-desc',
  })).json()
  assert.deepEqual(recentFirst.items.map(item => item.sessionId), ['session-mid', 'session-new'])

  const byCreated = await (await post(routes, 'candidates', {
    range: 'all', basis: 'created', state: 'open', sort: 'created-desc',
  })).json()
  assert.deepEqual(byCreated.items.map(item => item.sessionId), ['session-new', 'session-mid', 'session-old'])

  // Sort is independent of the range basis: active-desc follows last activity
  // even when the range is filtered by createdAt.
  const activeAgainstCreatedBasis = await (await post(routes, 'candidates', {
    range: 'all', basis: 'created', state: 'open', sort: 'active-desc',
  })).json()
  assert.deepEqual(activeAgainstCreatedBasis.items.map(item => item.sessionId), ['session-old', 'session-mid', 'session-new'])
})

test('candidates cap after sorting so oldest-first keeps the oldest sessions', async () => {
  const { routes, ctx } = makeHarness()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const records = Array.from({ length: 205 }, (_, index) => {
    const time = now - (index + 1) * day
    return {
      header: header(`session-cap-${index}`, { createdAt: time, lastActivityAt: time }),
      live: false,
      persisted: true,
      formatStatus: 'ok',
    }
  })
  ctx.sessionQuery.listSessions = () => records

  const body = await (await post(routes, 'candidates', {
    range: 'all', basis: 'created', state: 'open', sort: 'active-asc',
  })).json()
  assert.equal(body.openTotal, 205)
  assert.equal(body.items.length, 200)
  assert.equal(body.truncatedOpen, true)
  assert.equal(body.items[0].sessionId, 'session-cap-204')
  assert.equal(body.items[199].sessionId, 'session-cap-5')
  assert.ok(!body.items.some(item => item.sessionId === 'session-cap-0'))
})

test('candidates use the session log mtime for the activity basis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dkam-activity-'))
  try {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, '{}\n')
    const mtime = Date.now() - 1_000
    await utimes(path, new Date(mtime), new Date(mtime))
    const { routes } = makeHarness({
      snapshots: [{
        ...snapshot(SESSION_ID),
        location: { kind: 'file', path },
      }],
    })

    // The log was touched one second ago, so it is not "older than 7 days",
    // even though the fixture header was created in 2023.
    const result = await (await post(routes, 'candidates', { range: 'older7d', basis: 'activity' })).json()
    assert.equal(result.total, 1)
    assert.deepEqual(result.items.map(item => item.sessionId), [ACTIVE_ID])

    const all = await (await post(routes, 'candidates', { range: 'all', basis: 'activity' })).json()
    const archived = all.items.find(item => item.sessionId === SESSION_ID)
    assert.ok(Math.abs(archived.lastActivityAt - mtime) < 50)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archive-many refuses to stop an active session without explicit confirmation', async () => {
  await withHome(async () => {
    const { routes, archived, archiveCalls } = makeHarness()
    const active = await post(routes, 'archive-many', { sessionIds: [ACTIVE_ID] })
    assert.equal(active.status, 200)
    const activeBody = await active.json()
    assert.equal(activeBody.ok, false)
    assert.equal(activeBody.failed[0].reason, 'active')
    assert.equal(activeBody.failed[0].activity[0].kind, 'turn')
    assert.equal(archived.has(ACTIVE_ID), false)

    const unconfirmed = await post(routes, 'archive-many', {
      sessionIds: [ACTIVE_ID],
      stopActivity: true,
    })
    assert.equal(unconfirmed.status, 400)
    assert.equal((await unconfirmed.json()).reason, 'confirmation-required')

    const confirmed = await post(routes, 'archive-many', {
      sessionIds: [ACTIVE_ID],
      stopActivity: true,
      confirmStop: true,
    })
    assert.equal(confirmed.status, 200)
    const confirmedBody = await confirmed.json()
    assert.deepEqual(confirmedBody.archived, [ACTIVE_ID])
    assert.equal(archived.has(ACTIVE_ID), true)
    assert.deepEqual(archiveCalls.at(-1), { id: ACTIVE_ID, options: { stopActivity: true } })

    const listed = await post(routes, 'list', {})
    const item = (await listed.json()).items.find(entry => entry.sessionId === ACTIVE_ID)
    assert.equal(item.history.at(-1).action, 'archived')
    assert.equal(item.history.at(-1).source, 'user')
  })
})

test('saved views round-trip with filters and can be deleted', async () => {
  await withHome(async () => {
    const { routes } = makeHarness()
    const saved = await post(routes, 'view-save', {
      name: '  Design review  ',
      query: 'alpha',
      filter: 'tagged',
      sort: 'size-desc',
      tag: 'design',
    })
    assert.equal(saved.status, 200)
    const view = (await saved.json()).view
    assert.equal(view.name, 'Design review')
    assert.equal(view.filter, 'tagged')
    assert.equal(typeof view.id, 'string')

    const listed = await post(routes, 'views', {})
    assert.equal((await listed.json()).views.length, 1)

    const updated = await post(routes, 'view-save', {
      id: view.id,
      name: 'Renamed',
      query: 'beta',
      filter: 'noted',
      sort: 'title',
      tag: '',
    })
    assert.equal(updated.status, 200)
    const updatedView = (await updated.json()).view
    assert.equal(updatedView.id, view.id)
    assert.equal(updatedView.name, 'Renamed')
    assert.equal(updatedView.query, 'beta')

    const invalid = await post(routes, 'view-save', { name: '   ' })
    assert.equal(invalid.status, 400)

    const deleted = await post(routes, 'view-delete', { id: view.id })
    assert.equal(deleted.status, 200)
    assert.equal((await deleted.json()).deleted, true)
    const empty = await post(routes, 'views', {})
    assert.equal((await empty.json()).views.length, 0)
  })
})

test('notice returns the recorded archive timestamp', async () => {
  await withHome(async () => {
    const { routes, listeners } = makeHarness()
    assert.equal(typeof listeners.get('workspace/session-archived'), 'function')
    listeners.get('workspace/session-archived')({ sessionId: SESSION_ID })
    await new Promise(resolve => setTimeout(resolve, 40))

    const response = await post(routes, 'notice', { sessionId: SESSION_ID })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(typeof body.archivedAt, 'number')
    assert.ok(body.archivedAt > 0)
  })
})

test('agent tools stay off by default and expose bounded metadata when enabled', async () => {
  await withHome(async () => {
    const disabled = makeHarness({ tools: true })
    assert.equal(disabled.registeredTools.size, 0)

    const enabled = makeHarness({ tools: true, config: { tools: true } })
    assert.deepEqual([...enabled.registeredTools.keys()].sort(), [
      'archive_list',
      'archive_read',
      'archive_search',
    ])
    const list = await enabled.registeredTools.get('archive_list').execute({ limit: 10 })
    assert.equal(list.count, 2)
    assert.equal('firstUserText' in list.items[0], false)
    assert.equal('events' in list.items[0], false)

    const search = await enabled.registeredTools.get('archive_search').execute({ query: 'Archived' })
    assert.equal(search.count, 1)
    assert.equal(search.items[0].sessionId, SESSION_ID)

    const read = await enabled.registeredTools.get('archive_read').execute({
      sessionId: SESSION_ID,
      offset: 1,
      limit: 2,
    })
    assert.equal(read.eventCount, 5)
    assert.equal(read.items.length, 2)
    assert.equal(read.items[0].index, 1)
    assert.equal(read.nextOffset, 3)
    await assert.rejects(
      enabled.registeredTools.get('archive_read').execute({ sessionId: ACTIVE_ID }),
      /not archived/,
    )
  })
})
