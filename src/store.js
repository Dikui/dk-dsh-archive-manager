/**
 * Metadata store for dk-dsh-archive-manager.
 *
 * Preferred backend: DSH's schema-validated domain KV (`archive_manager` v1,
 * table `entries`). If that facility is unavailable, the same tiny interface is
 * served by an atomically written JSON file under the DSH home. The JSON
 * fallback keeps the plugin usable on older profiles; it is not a second source
 * of truth when the domain backend is available.
 *
 * @module dk-dsh-archive-manager/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeEntry } from './model.js'

/** Domain name declared by this plugin. DSH domain names use snake_case. */
export const DOMAIN_NAME = 'archive_manager'
/** Single table holding one metadata record per archived session. */
export const TABLE_NAME = 'entries'

/**
 * Minimal schema adapter for `domainTable`.
 *
 * The domain facility calls `valueSchema.parse(value)` when it loads a stored
 * record; it does not depend on a specific schema library at that call site.
 * Keeping this adapter local avoids making the plugin depend on a particular
 * zod copy in the profile.
 */
const entrySchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('archive entry must be an object')
    }
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
      throw new Error('archive entry must carry a sessionId')
    }
    return normalizeEntry(value.sessionId, value)
  },
  safeParse(value) {
    try {
      return { success: true, data: this.parse(value) }
    } catch (error) {
      return { success: false, error }
    }
  },
}

/**
 * Open the metadata store, preferring the domain KV backend.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<object>} Store handle.
 */
export async function openStore(ctx) {
  try {
    if (ctx.storageDomain === undefined || typeof ctx.storageDomain.open !== 'function') {
      throw new Error('storageDomain service is unavailable')
    }
    const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
    const spec = defineDomain({
      name: DOMAIN_NAME,
      version: 1,
      tables: { [TABLE_NAME]: domainTable(entrySchema) },
    })

    let domain
    let owned = true
    try {
      domain = await ctx.storageDomain.open(spec)
    } catch (error) {
      // A hot reload can still have the previous instance's domain open. Reuse
      // that handle instead of silently switching to the JSON fallback, which
      // would split metadata between two stores.
      if (error?.code === 'already-open' && typeof ctx.storageDomain.get === 'function') {
        domain = ctx.storageDomain.get(DOMAIN_NAME)
        owned = false
      }
      if (domain === undefined) throw error
    }

    const table = domain.table(TABLE_NAME)
    return {
      kind: 'domain',
      get: sessionId => {
        const value = table.get(sessionId)
        return value === undefined ? undefined : normalizeEntry(sessionId, value)
      },
      entries: () => {
        const out = []
        for (const [sessionId, value] of table.entries()) out.push([sessionId, normalizeEntry(sessionId, value)])
        return out
      },
      async put(sessionId, value) {
        const entry = normalizeEntry(sessionId, value)
        await table.put(sessionId, entry)
        return entry
      },
      async delete(sessionId) {
        return table.delete(sessionId)
      },
      async close() {
        if (owned) await domain.close()
      },
    }
  } catch (error) {
    ctx.logger?.warn?.('dk-dsh-archive-manager: domain store unavailable, using JSON fallback: %o', error)
    return openFileStore(ctx)
  }
}

/**
 * Last-resort store: one small JSON document under `$DSH_HOME/archive-manager`.
 * Writes are serialized and use write-temp-then-rename so a crash cannot leave
 * a torn document.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<object>} Store handle.
 */
async function openFileStore(ctx) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const path = join(home, 'archive-manager', 'entries.json')
  const records = new Map()

  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    const source = parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object'
      ? parsed.entries
      : parsed
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
      for (const [sessionId, value] of Object.entries(source)) {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          records.set(sessionId, normalizeEntry(sessionId, value))
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      ctx.logger?.warn?.('dk-dsh-archive-manager: could not read %s; starting empty: %o', path, error)
      try {
        await rename(path, `${path}.corrupt-${Date.now()}`)
      } catch { /* keep the unreadable file in place if it cannot be moved */ }
    }
  }

  let chain = Promise.resolve()
  const enqueue = task => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }
  const persist = () => enqueue(async () => {
    const snapshot = JSON.stringify({
      version: 1,
      entries: Object.fromEntries(records),
    }, null, 2)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, snapshot, { mode: 0o600 })
    await rename(temporary, path)
  })

  return {
    kind: 'json',
    get: sessionId => records.get(sessionId),
    entries: () => [...records.entries()],
    async put(sessionId, value) {
      const entry = normalizeEntry(sessionId, value)
      records.set(sessionId, entry)
      await persist()
      return entry
    },
    async delete(sessionId) {
      const existed = records.delete(sessionId)
      if (existed) await persist()
      return existed
    },
    async close() {
      await chain
    },
  }
}
