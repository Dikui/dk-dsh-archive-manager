import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clipText,
  entryForArchive,
  entryForRestore,
  filterItems,
  formatBytes,
  mergeEntryPatch,
  messageText,
  normalizeEntry,
  normalizeHistory,
  normalizeNote,
  normalizeTags,
  normalizeView,
  summarizeEvents,
  summarizeList,
  transcriptPage,
} from '../src/model.js'
import { DOMAIN_NAME, VIEW_DOMAIN_NAME, openStore } from '../src/store.js'

test('normalizeNote trims, caps, and rejects empty values', () => {
  assert.equal(normalizeNote('  hello  '), 'hello')
  assert.equal(normalizeNote('   '), undefined)
  assert.equal(normalizeNote(42), undefined)
  assert.equal(normalizeNote('x'.repeat(2100)).length, 2000)
})

test('normalizeTags dedupes case-insensitively and accepts strings', () => {
  assert.deepEqual(normalizeTags(' client, Client , 复盘 '), ['client', '复盘'])
  assert.deepEqual(normalizeTags(['a', 'A', ' b ']), ['a', 'b'])
  assert.deepEqual(normalizeTags('a, b, c'), ['a', 'b', 'c'])
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20)
  assert.equal(normalizeTags(['x'.repeat(100)])[0].length, 40)
})

test('normalizeEntry never invents an archive timestamp', () => {
  const unknown = normalizeEntry('s1', { tags: ['a'], source: 'user' })
  assert.equal(unknown.sessionId, 's1')
  assert.equal(unknown.archivedAt, undefined)
  assert.equal(unknown.inferred, true)
  assert.deepEqual(unknown.tags, ['a'])
  assert.equal(unknown.source, 'user')

  const known = normalizeEntry('s2', { archivedAt: 1700000000000, inferred: false })
  assert.equal(known.archivedAt, 1700000000000)
  assert.equal(known.inferred, false)
  assert.equal(known.source, 'plugin')
})

test('entryForArchive keeps the first observed time and refreshes after restore', () => {
  const first = entryForArchive('s1', undefined, 100)
  assert.equal(first.archivedAt, 100)
  assert.equal(first.inferred, false)

  const duplicate = entryForArchive('s1', first, 200)
  assert.equal(duplicate.archivedAt, 100)

  const restored = entryForRestore('s1', first, 300)
  assert.equal(restored.restoredAt, 300)
  assert.equal(restored.note, undefined)

  const rearchived = entryForArchive('s1', restored, 400)
  assert.equal(rearchived.archivedAt, 400)
  assert.equal(rearchived.restoredAt, undefined)
})

test('entryForRestore preserves note and tags', () => {
  const entry = normalizeEntry('s1', { archivedAt: 10, note: 'keep', tags: ['x'] })
  const restored = entryForRestore('s1', entry, 20)
  assert.equal(restored.note, 'keep')
  assert.deepEqual(restored.tags, ['x'])
  assert.equal(restored.archivedAt, 10)
  assert.equal(restored.restoredAt, 20)
})

test('mergeEntryPatch edits note/tags without dropping the archive time', () => {
  const entry = normalizeEntry('s1', { archivedAt: 10, note: 'old', tags: ['old'] })
  const next = mergeEntryPatch('s1', entry, { note: ' new ', tags: 'a, B' })
  assert.equal(next.note, 'new')
  assert.deepEqual(next.tags, ['a', 'B'])
  assert.equal(next.archivedAt, 10)
  assert.equal(next.source, 'user')

  const cleared = mergeEntryPatch('s1', next, { note: '' })
  assert.equal(cleared.note, undefined)
  assert.deepEqual(cleared.tags, ['a', 'B'])
})

test('messageText extracts only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }), 'one\ntwo')
  assert.equal(messageText({ content: 'not-an-array' }), '')
  assert.equal(messageText(null), '')
})

test('clipText clips on a character boundary', () => {
  assert.equal(clipText('  hello  '), 'hello')
  assert.equal(clipText('abcdef', 3), 'abc…')
  assert.equal(clipText('abc', 3), 'abc')
})

test('summarizeEvents projects turns, tools, and excerpts', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 2, data: {} },
    { type: 'user/message', time: 3, data: { role: 'user', content: [{ type: 'text', text: 'first question' }] } },
    { type: 'tool/call', time: 4, data: { name: 'read' } },
    { type: 'tool/call', time: 5, data: { name: 'read' } },
    { type: 'tool/call', time: 6, data: { name: 'grep' } },
    { type: 'assistant/message', time: 7, data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
    { type: 'user/message', time: 8, data: { role: 'user', content: [{ type: 'text', text: 'second question' }] } },
    { type: 'assistant/message', time: 9, data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
  ]
  const summary = summarizeEvents(events)
  assert.equal(summary.eventCount, 9)
  assert.equal(summary.turns, 1)
  assert.equal(summary.steps, 1)
  assert.equal(summary.toolCalls, 3)
  assert.equal(summary.firstUserText, 'first question')
  assert.equal(summary.lastUserText, 'second question')
  assert.equal(summary.lastAssistantText, 'final answer')
  assert.equal(summary.lastEventTime, 9)
  assert.deepEqual(summary.topTools, [{ name: 'read', count: 2 }, { name: 'grep', count: 1 }])
})

test('filterItems handles query, tag, and sort views', () => {
  const items = [
    { sessionId: 'a', title: 'Alpha', archivedAt: 10, createdAt: 5, sizeBytes: 100, tags: ['client'], note: 'x' },
    { sessionId: 'b', title: 'Beta', archivedAt: 20, createdAt: 6, sizeBytes: 300, tags: [] },
    { sessionId: 'c', title: 'Gamma', archivedAt: null, createdAt: 7, sizeBytes: null, tags: ['review'] },
    { sessionId: 'd', title: 'Ghost', archivedAt: 30, createdAt: 8, sizeBytes: 50, ghost: true },
  ]
  assert.deepEqual(filterItems(items, { query: 'alpha' }).map(item => item.sessionId), ['a'])
  assert.deepEqual(filterItems(items, { filter: 'tagged' }).map(item => item.sessionId), ['a', 'c'])
  assert.deepEqual(filterItems(items, { filter: 'unknown' }).map(item => item.sessionId), ['c'])
  assert.deepEqual(filterItems(items, { filter: 'ghost' }).map(item => item.sessionId), ['d'])
  assert.deepEqual(filterItems(items, { tag: 'client' }).map(item => item.sessionId), ['a'])
  assert.deepEqual(filterItems(items, { sort: 'archived-desc' }).map(item => item.sessionId), ['d', 'b', 'a', 'c'])
  assert.deepEqual(filterItems(items, { sort: 'size-desc' }).map(item => item.sessionId), ['b', 'a', 'd', 'c'])
  assert.deepEqual(filterItems(items, { sort: 'title' }).map(item => item.sessionId), ['a', 'b', 'c', 'd'])
})

test('summarizeList reports known and unknown capacity', () => {
  const summary = summarizeList([
    { sizeBytes: 100, archivedAt: 10 },
    { sizeBytes: null, archivedAt: null },
    { sizeBytes: 200 },
  ])
  assert.equal(summary.count, 3)
  assert.equal(summary.totalSize, 300)
  assert.equal(summary.knownSizeCount, 2)
  assert.equal(summary.unknownSizeCount, 1)
  assert.equal(summary.unknownArchivedAtCount, 2)
  assert.equal(summary.latestArchivedAt, 10)
})

test('normalizeHistory sorts, dedupes, and drops invalid events', () => {
  const history = normalizeHistory([
    { at: 20, action: 'restored', source: 'user' },
    { at: 10, action: 'archived', source: 'plugin' },
    { at: 10, action: 'archived', source: 'plugin' },
    { at: 30, action: 'unknown' },
    { at: 'bad', action: 'archived' },
  ])
  assert.deepEqual(history, [
    { at: 10, action: 'archived', source: 'plugin' },
    { at: 20, action: 'restored', source: 'user' },
  ])
})

test('normalizeHistory keeps the newest events when the cap is exceeded', () => {
  const history = normalizeHistory(Array.from({ length: 60 }, (_, index) => ({
    at: 1_000 + index,
    action: index % 2 === 0 ? 'archived' : 'restored',
    source: 'plugin',
  })))
  assert.equal(history.length, 50)
  assert.equal(history[0].at, 1_010)
  assert.equal(history.at(-1).at, 1_059)
})

test('entry history records archive and restore, including re-archive', () => {
  const first = entryForArchive('s1', undefined, 100, 'user')
  assert.deepEqual(first.history, [{ at: 100, action: 'archived', source: 'user' }])
  const restored = entryForRestore('s1', first, 200, 'user')
  assert.deepEqual(restored.history.map(event => event.action), ['archived', 'restored'])
  const rearchived = entryForArchive('s1', restored, 300)
  assert.equal(rearchived.archivedAt, 300)
  assert.deepEqual(rearchived.history.map(event => event.action), ['archived', 'restored', 'archived'])
})

test('normalizeEntry rebuilds the audit trail for legacy records', () => {
  const entry = normalizeEntry('s1', { archivedAt: 10, restoredAt: 20 })
  assert.deepEqual(entry.history, [
    { at: 10, action: 'archived', source: 'plugin' },
    { at: 20, action: 'restored', source: 'plugin' },
  ])
})

test('transcriptPage returns bounded rows and pagination facts', () => {
  const events = [
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'tool/call', time: 3, data: { name: 'read', arguments: { path: 'a' } } },
    { type: 'system/message', time: 4, data: { message: { content: [{ type: 'text', text: 'note' }] } } },
  ]
  const page = transcriptPage(events, { offset: 1, limit: 2 })
  assert.equal(page.total, 4)
  assert.equal(page.items.length, 2)
  assert.equal(page.items[0].index, 1)
  assert.equal(page.items[0].role, 'assistant')
  assert.equal(page.items[0].text, 'hi')
  assert.equal(page.items[1].role, 'tool')
  assert.equal(page.items[1].name, 'read')
  assert.equal(page.hasMore, true)
  assert.equal(page.nextOffset, 3)

  const tail = transcriptPage(events, { offset: 3, limit: 2 })
  assert.equal(tail.items.length, 1)
  assert.equal(tail.hasMore, false)
  assert.equal(tail.nextOffset, null)

  const bounded = transcriptPage([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }], { limit: 500 })
  assert.equal(bounded.limit, 100)
  assert.equal(bounded.items[0].truncated, true)
  assert.ok(bounded.items[0].text.length <= 1201)
})

test('normalizeView validates names and view fields', () => {
  const view = normalizeView('view-1', {
    name: '  Focus  ',
    query: '  alpha ',
    filter: 'tagged',
    sort: 'size-desc',
    tag: ' design ',
    createdAt: 10,
    updatedAt: 20,
  })
  assert.equal(view.name, 'Focus')
  assert.equal(view.query, 'alpha')
  assert.equal(view.filter, 'tagged')
  assert.equal(view.sort, 'size-desc')
  assert.equal(view.tag, 'design')
  assert.equal(normalizeView('', { name: 'x' }), undefined)
  assert.equal(normalizeView('v', { name: '   ' }), undefined)
  assert.equal(normalizeView('v', { name: 'x', filter: 'bogus', sort: 'bogus' }).filter, 'all')
  assert.equal(normalizeView('v', { name: 'x', filter: 'bogus', sort: 'bogus' }).sort, 'archived-desc')
})

test('formatBytes uses readable units', () => {
  assert.equal(formatBytes(500), '500 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB')
  assert.equal(formatBytes(undefined), '—')
})

test('JSON fallback store round-trips metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dkam-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = { logger: { warn() {} } }
    const store = await openStore(ctx)
    assert.equal(store.kind, 'json')
    await store.put('s1', { sessionId: 's1', note: 'hello', tags: ['x'], inferred: true })
    await store.putView({ id: 'v1', name: 'Focus', query: 'alpha', filter: 'tagged', sort: 'title', tag: 'design', createdAt: 10, updatedAt: 20 })
    assert.equal(store.get('s1').note, 'hello')
    assert.equal(store.get('s1').archivedAt, undefined)
    assert.equal(store.getView('v1').name, 'Focus')
    await store.close()

    const reopened = await openStore(ctx)
    assert.equal(reopened.get('s1').note, 'hello')
    assert.deepEqual(reopened.get('s1').tags, ['x'])
    assert.equal(reopened.getView('v1').filter, 'tagged')
    assert.equal(reopened.views().length, 1)
    await reopened.close()
    const raw = JSON.parse(await readFile(join(home, 'archive-manager', 'entries.json'), 'utf8'))
    assert.equal(raw.version, 2)
    assert.ok(Array.isArray(raw.views))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('domain names are valid for the DSH domain facility', () => {
  assert.match(DOMAIN_NAME, /^[a-z][a-z0-9_]*$/)
  assert.match(VIEW_DOMAIN_NAME, /^[a-z][a-z0-9_]*$/)
})
