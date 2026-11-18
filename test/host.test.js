import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ROUTE_BASE, apply } from '../index.js'

const SESSION_ID = 'session-11111111-1111-4111-8111-111111111111'
const GHOST_ID = 'session-22222222-2222-4222-8222-222222222222'

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

function makeHarness({ getter = true } = {}) {
  const routes = new Map()
  const listeners = new Map()
  const archived = new Set([SESSION_ID, GHOST_ID])
  const entries = new Map()

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
      async unarchiveSession(id) {
        archived.delete(id)
      },
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
        return [snapshot(SESSION_ID)]
      },
      stat(id) {
        return id === SESSION_ID ? snapshot(id) : undefined
      },
    },
    storageDomain: undefined,
  }

  if (getter) {
    Object.defineProperty(ctx.workspaceRegistry, 'archivedSessionIds', {
      get: () => [...archived],
    })
  }

  apply(ctx)
  return { ctx, routes, listeners, archived, entries }
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

test('registers five POST routes', () => {
  const { routes } = makeHarness()
  for (const name of ['list', 'preview', 'entry', 'unarchive', 'unarchive-many']) {
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
