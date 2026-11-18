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
  normalizeNote,
  normalizeTags,
  summarizeEvents,
  summarizeList,
} from '../src/model.js'
import { DOMAIN_NAME, openStore } from '../src/store.js'

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
    assert.equal(store.get('s1').note, 'hello')
    assert.equal(store.get('s1').archivedAt, undefined)
    await store.close()

    const reopened = await openStore(ctx)
    assert.equal(reopened.get('s1').note, 'hello')
    assert.deepEqual(reopened.get('s1').tags, ['x'])
    await reopened.close()
    assert.equal(JSON.parse(await readFile(join(home, 'archive-manager', 'entries.json'), 'utf8')).version, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('domain name is valid for the DSH domain facility', () => {
  assert.match(DOMAIN_NAME, /^[a-z][a-z0-9_]*$/)
})
