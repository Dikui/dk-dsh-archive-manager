/**
 * Pure model helpers shared by the Host and tests.
 *
 * Everything here is side-effect free: normalization, transcript projection,
 * filtering, sorting, and byte formatting. The Host route layer and the Client
 * keep their own thin adapters so this file can be unit-tested without a DSH
 * runtime.
 *
 * @module dk-dsh-archive-manager/model
 */

/** Longest note accepted from the UI. */
export const NOTE_MAX = 2000
/** Longest single tag accepted. */
export const TAG_MAX = 40
/** Most tags kept on one archive entry. */
export const TAGS_MAX = 20
/** Longest saved-view name accepted. */
export const VIEW_NAME_MAX = 40
/** Most saved views kept per profile. */
export const VIEWS_MAX = 50
/** Most audit entries kept on one archive record. */
export const HISTORY_MAX = 50
/** Longest transcript text returned per event. */
export const TRANSCRIPT_TEXT_MAX = 1200
/** Valid list filters mirrored by the Client. */
export const LIST_FILTERS = ['all', 'noted', 'tagged', 'unknown', 'ghost']
/** Valid list sorts mirrored by the Client. */
export const LIST_SORTS = ['archived-desc', 'archived-asc', 'active-desc', 'size-desc', 'title']

/**
 * Normalize a user note: trim, collapse nothing, cap length.
 * @param {unknown} value - Candidate note.
 * @returns {string | undefined} Trimmed note, or undefined when empty/invalid.
 */
export function normalizeNote(value) {
  if (typeof value !== 'string') return undefined
  const note = value.trim()
  if (note.length === 0) return undefined
  return note.slice(0, NOTE_MAX)
}

/**
 * Normalize tags from an array or a comma-separated string.
 * Tags are trimmed, de-duplicated case-insensitively, capped in count and length.
 * @param {unknown} value - Candidate tags.
 * @returns {string[]} Stable, ordered tag list.
 */
export function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const seen = new Set()
  const tags = []
  for (const raw of source) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, TAG_MAX)
    if (tag.length === 0) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= TAGS_MAX) break
  }
  return tags
}

/**
 * Normalize the audit trail: valid timestamps only, chronological, de-duplicated,
 * capped at HISTORY_MAX. The trail is optional so pre-upgrade entries still load.
 * @param {unknown} value - Stored trail.
 * @returns {{ at: number, action: 'archived' | 'restored', source: 'user' | 'plugin' | 'system' }[]} Normalized trail.
 */
export function normalizeHistory(value) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(value) ? value : []) {
    if (raw === null || typeof raw !== 'object') continue
    const at = Number.isFinite(raw.at) && raw.at > 0 ? raw.at : undefined
    if (at === undefined) continue
    const action = raw.action === 'restored' ? 'restored' : raw.action === 'archived' ? 'archived' : undefined
    if (action === undefined) continue
    const key = `${action}:${at}`
    if (seen.has(key)) continue
    seen.add(key)
    const source = raw.source === 'user' ? 'user' : raw.source === 'system' ? 'system' : 'plugin'
    out.push({ at, action, source })
  }
  out.sort((a, b) => a.at - b.at)
  // Keep the newest events when a record exceeds the cap, even if the input
  // arrived out of order.
  return out.slice(-HISTORY_MAX)
}

/**
 * Append one audit event. A repeated archive notification keeps the first
 * archived event; a re-archive after restore appends a fresh one.
 * @param {readonly { at: number, action: 'archived' | 'restored', source: 'user' | 'plugin' | 'system' }[]} history - Existing trail.
 * @param {number} at - Event timestamp.
 * @param {'archived' | 'restored'} action - Event kind.
 * @param {'user' | 'plugin' | 'system'} source - Who acted.
 * @returns {{ at: number, action: 'archived' | 'restored', source: 'user' | 'plugin' | 'system' }[]} New trail.
 */
export function appendHistory(history, at, action, source) {
  const base = normalizeHistory(history)
  const last = base[base.length - 1]
  if (last !== undefined && last.action === action && Math.abs(last.at - at) < 2000) return base
  const next = [...base, { at, action, source }]
  return next.slice(-HISTORY_MAX)
}

/**
 * Coerce one stored record into the current entry shape.
 *
 * Missing archive time is preserved as "unknown" instead of inventing a time:
 * DSH's built-in archive set never stored one, so pre-install archives can only
 * be shown as unknown.
 *
 * @param {string} sessionId - Session id (authoritative key).
 * @param {unknown} value - Stored record.
 * @returns {{ sessionId: string, archivedAt?: number, note?: string, tags: string[], source: 'user' | 'plugin', inferred: boolean, restoredAt?: number, history: { at: number, action: 'archived' | 'restored', source: 'user' | 'plugin' | 'system' }[] }} Normalized entry.
 */
export function normalizeEntry(sessionId, value) {
  const record = value !== null && typeof value === 'object' ? value : {}
  const archivedAt = Number.isFinite(record.archivedAt) && record.archivedAt > 0
    ? record.archivedAt
    : undefined
  const restoredAt = Number.isFinite(record.restoredAt) && record.restoredAt > 0
    ? record.restoredAt
    : undefined
  const note = normalizeNote(record.note)
  const tags = normalizeTags(record.tags)
  const source = record.source === 'user' ? 'user' : 'plugin'
  let history = normalizeHistory(record.history)
  // Old records predate the trail. Reconstruct the events they already know
  // about instead of dropping the timeline on upgrade.
  if (history.length === 0 && archivedAt !== undefined) {
    history = appendHistory(history, archivedAt, 'archived', source)
    if (restoredAt !== undefined && restoredAt > archivedAt) {
      history = appendHistory(history, restoredAt, 'restored', source)
    }
  }
  const entry = {
    sessionId,
    tags,
    source,
    inferred: archivedAt !== undefined ? record.inferred !== false : true,
    history,
  }
  if (archivedAt !== undefined) entry.archivedAt = archivedAt
  if (note !== undefined) entry.note = note
  if (restoredAt !== undefined) entry.restoredAt = restoredAt
  return entry
}

/**
 * Create or refresh the metadata entry for a newly archived session.
 * A re-archive after restore refreshes the time; duplicate archive notifications
 * keep the first observed time.
 * @param {string} sessionId - Session id.
 * @param {unknown} current - Existing entry, if any.
 * @param {number} now - Timestamp for a newly observed archive.
 * @param {'user' | 'plugin' | 'system'} [source] - Who triggered the archive.
 * @returns {ReturnType<typeof normalizeEntry>} Entry to persist.
 */
export function entryForArchive(sessionId, current, now, source = 'plugin') {
  const base = normalizeEntry(sessionId, current)
  const existing = base.archivedAt
  const archivedAt = base.restoredAt !== undefined ? now : existing ?? now
  const next = {
    ...base,
    archivedAt,
    inferred: false,
    source: base.source === 'user' ? 'user' : source,
    history: appendHistory(base.history, archivedAt, 'archived', source),
  }
  delete next.restoredAt
  return next
}

/**
 * Mark an entry as restored without losing its note or tags.
 * @param {string} sessionId - Session id.
 * @param {unknown} current - Existing entry.
 * @param {number} now - Restore timestamp.
 * @param {'user' | 'plugin' | 'system'} [source] - Who triggered the restore.
 * @returns {ReturnType<typeof normalizeEntry>} Entry to persist.
 */
export function entryForRestore(sessionId, current, now, source = 'user') {
  const base = normalizeEntry(sessionId, current)
  return {
    ...base,
    restoredAt: now,
    history: appendHistory(base.history, now, 'restored', source),
  }
}

/**
 * Apply a note/tag edit to an entry.
 * @param {string} sessionId - Session id.
 * @param {unknown} current - Existing entry.
 * @param {{ note?: unknown, tags?: unknown }} patch - Validated patch fields.
 * @returns {ReturnType<typeof normalizeEntry>} Entry to persist.
 */
export function mergeEntryPatch(sessionId, current, patch) {
  const base = normalizeEntry(sessionId, current)
  const next = { ...base, source: 'user' }
  if ('note' in patch) {
    const note = normalizeNote(patch.note)
    if (note === undefined) delete next.note
    else next.note = note
  }
  if ('tags' in patch) next.tags = normalizeTags(patch.tags)
  if (next.archivedAt === undefined) next.inferred = true
  return next
}

/**
 * Extract visible text from a message's content blocks.
 * @param {unknown} message - Message-like object.
 * @returns {string} Joined text blocks.
 */
export function messageText(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Clip long preview text on a code-point boundary.
 * @param {string} text - Source text.
 * @param {number} [max] - Maximum length.
 * @returns {string} Clipped text.
 */
export function clipText(text, max = 600) {
  if (typeof text !== 'string') return ''
  const value = text.trim()
  if (value.length <= max) return value
  return `${value.slice(0, max).trimEnd()}…`
}

/**
 * Project a session log into the compact preview the archive center shows.
 * @param {readonly { type: string, time?: number, data?: unknown }[]} events - Session events.
 * @returns {object} Counts and excerpt text.
 */
export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events : []
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let userMessages = 0
  let assistantMessages = 0
  let firstUserText = ''
  let lastUserText = ''
  let lastAssistantText = ''
  let lastEventTime = 0
  let lastEventType = ''
  const tools = new Map()

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    if (Number.isFinite(event.time)) lastEventTime = Math.max(lastEventTime, event.time)
    if (typeof event.type === 'string') lastEventType = event.type

    switch (event.type) {
      case 'turn/start':
        turns += 1
        break
      case 'step/start':
        steps += 1
        break
      case 'tool/call': {
        toolCalls += 1
        const name = event.data !== null && typeof event.data === 'object' ? event.data.name : undefined
        if (typeof name === 'string' && name.length > 0) tools.set(name, (tools.get(name) ?? 0) + 1)
        break
      }
      case 'user/message': {
        const text = messageText(event.data)
        if (text.length > 0) {
          userMessages += 1
          lastUserText = text
          if (firstUserText.length === 0) firstUserText = text
        }
        break
      }
      case 'assistant/message': {
        const data = event.data !== null && typeof event.data === 'object' ? event.data : undefined
        const text = messageText(data?.message)
        if (text.length > 0) {
          assistantMessages += 1
          lastAssistantText = text
        }
        break
      }
    }
  }

  const topTools = [...tools.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }))

  return {
    eventCount: list.length,
    turns,
    steps,
    toolCalls,
    userMessages,
    assistantMessages,
    firstUserText: clipText(firstUserText),
    lastUserText: clipText(lastUserText),
    lastAssistantText: clipText(lastAssistantText),
    lastEventTime: lastEventTime || 0,
    lastEventType,
    topTools,
  }
}

/**
 * Serialize an unknown value for a transcript row without throwing.
 * @param {unknown} value - Value to show.
 * @returns {string} Compact JSON or an empty string.
 */
function stringifyForTranscript(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Project one session event into a bounded, read-only transcript row.
 * @param {{ type?: unknown, time?: unknown, data?: unknown }} event - Session event.
 * @param {number} index - Position in the full log.
 * @returns {{ index: number, type: string, time: number | null, role: string | null, name: string | null, text: string, truncated: boolean }} Row.
 */
export function transcriptEvent(event, index) {
  const source = event !== null && typeof event === 'object' ? event : {}
  const type = typeof source.type === 'string' ? source.type : ''
  const time = Number.isFinite(source.time) ? source.time : null
  const data = source.data !== null && typeof source.data === 'object' ? source.data : undefined
  let role = null
  let name = null
  let raw = ''

  switch (type) {
    case 'user/message':
      role = 'user'
      raw = messageText(data)
      break
    case 'assistant/message':
      role = 'assistant'
      raw = messageText(data?.message)
      break
    case 'assistant/reasoning':
      role = 'assistant'
      raw = typeof data?.text === 'string' ? data.text : stringifyForTranscript(data?.reasoning)
      break
    case 'tool/call':
      role = 'tool'
      name = typeof data?.name === 'string' ? data.name : null
      raw = stringifyForTranscript(data?.arguments ?? data?.input)
      break
    case 'tool/result':
      role = 'tool'
      name = typeof data?.name === 'string' ? data.name : null
      raw = stringifyForTranscript(data?.result ?? data?.output ?? data)
      break
    case 'system/message':
      role = 'system'
      raw = messageText(data?.message ?? data)
      break
    default:
      raw = typeof data?.text === 'string' ? data.text : ''
  }

  const text = clipText(raw, TRANSCRIPT_TEXT_MAX)
  return {
    index,
    type,
    time,
    role,
    name,
    text,
    truncated: typeof raw === 'string' && raw.trim().length > TRANSCRIPT_TEXT_MAX,
  }
}

/**
 * Project one bounded page of a session log. The caller supplies the already
 * read events; this helper never returns the whole log.
 * @param {readonly object[]} events - Session events.
 * @param {{ offset?: number, limit?: number }} [options] - Page options.
 * @returns {{ total: number, offset: number, limit: number, hasMore: boolean, nextOffset: number | null, items: object[] }} Page.
 */
export function transcriptPage(events, options = {}) {
  const total = Array.isArray(events) ? events.length : 0
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 40
  const start = Math.min(offset, total)
  const end = Math.min(start + limit, total)
  const items = []
  for (let index = start; index < end; index += 1) {
    items.push(transcriptEvent(events[index], index))
  }
  return {
    total,
    offset: start,
    limit,
    hasMore: end < total,
    nextOffset: end < total ? end : null,
    items,
  }
}

/**
 * Normalize a saved view. Returns undefined for a nameless/invalid record.
 * @param {string} id - Stable view id.
 * @param {unknown} value - Stored view.
 * @returns {{ id: string, name: string, query: string, filter: string, sort: string, tag: string, createdAt: number, updatedAt: number } | undefined} View.
 */
export function normalizeView(id, value) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  const record = value !== null && typeof value === 'object' ? value : {}
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, VIEW_NAME_MAX) : ''
  if (name.length === 0) return undefined
  const query = typeof record.query === 'string' ? record.query.trim().slice(0, 200) : ''
  const filter = LIST_FILTERS.includes(record.filter) ? record.filter : 'all'
  const sort = LIST_SORTS.includes(record.sort) ? record.sort : 'archived-desc'
  const tag = typeof record.tag === 'string' ? record.tag.trim().slice(0, TAG_MAX) : ''
  const createdAt = Number.isFinite(record.createdAt) && record.createdAt > 0 ? record.createdAt : Date.now()
  const updatedAt = Number.isFinite(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt : createdAt
  return { id, name, query, filter, sort, tag, createdAt, updatedAt }
}

/**
 * Filter and sort archive list items for the Client.
 * @param {readonly object[]} items - Archive items.
 * @param {{ query?: string, filter?: string, tag?: string, sort?: string }} [options] - View options.
 * @returns {object[]} Filtered, sorted copy.
 */
export function filterItems(items, options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim().toLocaleLowerCase() : ''
  const filter = options.filter ?? 'all'
  const tag = typeof options.tag === 'string' ? options.tag.trim().toLocaleLowerCase() : ''
  const sort = options.sort ?? 'archived-desc'

  const filtered = (Array.isArray(items) ? items : []).filter(item => {
    if (item === null || typeof item !== 'object') return false
    if (filter === 'noted' && !item.note) return false
    if (filter === 'tagged' && !(Array.isArray(item.tags) && item.tags.length > 0)) return false
    if (filter === 'unknown' && item.archivedAt) return false
    if (filter === 'ghost' && item.ghost !== true) return false
    if (tag.length > 0) {
      const tags = Array.isArray(item.tags) ? item.tags : []
      if (!tags.some(value => String(value).toLocaleLowerCase() === tag)) return false
    }
    if (query.length > 0) {
      const haystack = [
        item.title,
        item.workspaceTitle,
        item.cwd,
        item.note,
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        item.sessionId,
      ].filter(Boolean).join('\n').toLocaleLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })

  const byNumber = (a, b) => (Number.isFinite(b) ? b : -Infinity) - (Number.isFinite(a) ? a : -Infinity)
  filtered.sort((a, b) => {
    switch (sort) {
      case 'archived-asc':
        return (a.archivedAt ?? Number.POSITIVE_INFINITY) - (b.archivedAt ?? Number.POSITIVE_INFINITY)
          || (b.createdAt ?? 0) - (a.createdAt ?? 0)
      case 'active-desc':
        return byNumber(a.lastActivityAt, b.lastActivityAt) || byNumber(a.createdAt, b.createdAt)
      case 'size-desc':
        return byNumber(a.sizeBytes, b.sizeBytes) || byNumber(a.createdAt, b.createdAt)
      case 'title':
        return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh')
      case 'archived-desc':
      default:
        return (b.archivedAt ?? -Infinity) - (a.archivedAt ?? -Infinity)
          || (b.createdAt ?? 0) - (a.createdAt ?? 0)
    }
  })
  return filtered
}

/**
 * Aggregate capacity and coverage for the list header.
 * @param {readonly object[]} items - Archive items.
 * @returns {{ count: number, totalSize: number, knownSizeCount: number, unknownSizeCount: number, unknownArchivedAtCount: number, earliestArchivedAt: number | null, latestArchivedAt: number | null }} Summary.
 */
export function summarizeList(items) {
  let totalSize = 0
  let knownSizeCount = 0
  let unknownSizeCount = 0
  let unknownArchivedAtCount = 0
  let earliestArchivedAt = null
  let latestArchivedAt = null
  for (const item of Array.isArray(items) ? items : []) {
    if (Number.isFinite(item?.sizeBytes)) {
      totalSize += item.sizeBytes
      knownSizeCount += 1
    } else {
      unknownSizeCount += 1
    }
    if (Number.isFinite(item?.archivedAt)) {
      earliestArchivedAt = earliestArchivedAt === null ? item.archivedAt : Math.min(earliestArchivedAt, item.archivedAt)
      latestArchivedAt = latestArchivedAt === null ? item.archivedAt : Math.max(latestArchivedAt, item.archivedAt)
    } else {
      unknownArchivedAtCount += 1
    }
  }
  return {
    count: Array.isArray(items) ? items.length : 0,
    totalSize,
    knownSizeCount,
    unknownSizeCount,
    unknownArchivedAtCount,
    earliestArchivedAt,
    latestArchivedAt,
  }
}

/**
 * Human-readable bytes for the Client header and rows.
 * @param {unknown} value - Byte count.
 * @returns {string} Formatted size, or an em dash when unknown.
 */
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}
