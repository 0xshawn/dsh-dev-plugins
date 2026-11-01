/**
 * dsh-remote-access token statistics: the host half of the sidebar statistics
 * panel.
 *
 * The Host already owns every durable fact this page needs, so the collector
 * reads through the public session services instead of touching session files:
 *
 *  - `ctx.sessionQuery.listSessions` lists every live and persisted Session
 *    (the panel wants the whole history, including subagents and archived
 *    Sessions);
 *  - `ctx.sessionQuery.readSession` returns one validated complete event log,
 *    live-preferred, without activating an Agent;
 *  - `ctx.workspaceRegistry` maps Session directories to workspace records.
 *
 * Token accounting replays the same durable facts the stock `tokenUsage`
 * projection folds: one provider usage sample per settled Turn/step, with a
 * retried step contributing its replacement attempt. Every sample is
 * attributed to the local day of the event that settled it, so the day chart
 * adds up to the same total the chat stats pill shows.
 *
 * The data route is read-only and runs the same Host/Origin and launch-token
 * cookie checks as the stock `/api` fence.
 */
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'

/** Exact pathname of the statistics JSON route. */
export const STATS_DATA_PATH = '/dsh-remote-access/stats/data'

/** Bounded session-log read concurrency; persistence is the expensive step. */
const SESSION_READ_CONCURRENCY = 3
/** Safety bound for a filled day series (about ten years). */
const MAX_DAYS = 3660
/** The four disjoint provider buckets the page renders. */
const BUCKET_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** The Host lacks the session services the statistics page needs. */
export class StatsUnavailableError extends Error {
  /**
   * @param message - operator-facing explanation.
   */
  constructor(message) {
    super(message)
    this.name = 'StatsUnavailableError'
  }
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function zeroBuckets() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

function addBuckets(target, source) {
  for (const key of BUCKET_KEYS) target[key] += source[key]
  return target
}

function bucketsTotal(buckets) {
  return BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0)
}

function withTotal(buckets) {
  return { ...buckets, totalTokens: bucketsTotal(buckets) }
}

function bucketsEqual(left, right) {
  return BUCKET_KEYS.every((key) => left[key] === right[key])
}

/**
 * Convert one provider usage sample to the projection's disjoint buckets.
 * @param usage - provider `usage` record.
 * @returns buckets, or undefined when the sample is not a safe non-negative count.
 */
function bucketsFromUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const buckets = {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
  return BUCKET_KEYS.every((key) => isCount(buckets[key])) ? buckets : undefined
}

/**
 * Last `usage` chunk embedded in one compact Assistant stream.
 * @param stream - durable compact stream records.
 * @returns the usage sample, or undefined.
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Fold one Session log into provider usage settlements.
 *
 * Mirrors the stock `tokenUsage` projection: a settlement for the same
 * Turn/step replaces the previous sample, while `llm/retry-started` closes the
 * replacement slot so the retried attempt adds to the total. Fork-inherited
 * events are skipped: they are the parent Session's usage and would otherwise
 * be counted twice across the corpus.
 * @param events - complete raw Session event log.
 * @param inheritedEventCount - fork-inherited leading event count.
 * @returns one `{ time, buckets }` entry per billed settlement.
 */
export function foldSessionUsage(events, inheritedEventCount = 0) {
  const settlements = new Map()
  let last
  let generation = 0
  for (const event of events ?? []) {
    const seq = event?.seq
    if (Number.isSafeInteger(seq) && seq < inheritedEventCount) continue
    const data = event?.data
    if (event?.type === 'llm/retry-started') {
      if (last !== undefined && last.turn === data?.turn && last.step === data?.step) {
        last = undefined
        generation += 1
      }
      continue
    }
    let sample
    if (event?.type === 'assistant/message') sample = data?.usage ?? streamUsage(data?.stream)
    else if (event?.type === 'assistant/attempt') sample = streamUsage(data?.stream)
    if (sample === undefined) continue
    const buckets = bucketsFromUsage(sample)
    if (buckets === undefined) continue
    const turn = data.turn
    const step = data.step
    const previous = last !== undefined && last.turn === turn && last.step === step ? last.buckets : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) continue
    settlements.set(`${turn}:${step}:${generation}`, {
      time: Number.isFinite(event.time) ? event.time : 0,
      buckets,
    })
    last = { turn, step, buckets }
  }
  return [...settlements.values()]
}

/**
 * Resolve an IANA time zone to a local-day key function.
 * @param timeZone - requested browser time zone.
 * @returns the effective zone and its `YYYY-MM-DD` key function.
 */
function createDayKey(timeZone) {
  let effective = timeZone
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    effective = 'UTC'
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }
  return {
    effectiveTimeZone: effective,
    dayKey(time) {
      const parts = formatter.formatToParts(new Date(time))
      const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
      const month = parts.find((part) => part.type === 'month')?.value ?? '01'
      const day = parts.find((part) => part.type === 'day')?.value ?? '01'
      return `${year}-${month}-${day}`
    },
  }
}

/** The next calendar day after one `YYYY-MM-DD` key. */
function nextDayKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

function normalizeRange(from, to) {
  const lower = Number.isFinite(from) ? from : null
  const upper = Number.isFinite(to) ? to : null
  if (lower !== null && upper !== null && lower > upper) return { from: upper, to: lower }
  return { from: lower, to: upper }
}

/**
 * Aggregate session settlements into the statistics payload.
 * @param options - session entries, inclusive time range, IANA zone, and clock.
 * @returns the JSON-safe payload the browser panel renders.
 */
export function buildStats({ sessions = [], from = null, to = null, timeZone = 'UTC', now = Date.now() } = {}) {
  const range = normalizeRange(from, to)
  const { effectiveTimeZone, dayKey } = createDayKey(timeZone)
  const days = new Map()
  const workspaces = new Map()
  const totals = zeroBuckets()
  let sessionsInRange = 0

  const dayRow = (key) => {
    let row = days.get(key)
    if (row === undefined) {
      row = { date: key, ...zeroBuckets() }
      days.set(key, row)
    }
    return row
  }

  for (const session of sessions) {
    const workspace = session?.workspace ?? { id: 'unknown', title: '', path: '' }
    let counted = false
    for (const settlement of session?.attempts ?? []) {
      const time = settlement?.time
      if (!Number.isFinite(time)) continue
      if (range.from !== null && time < range.from) continue
      if (range.to !== null && time > range.to) continue
      const buckets = settlement.buckets
      if (buckets === undefined) continue
      addBuckets(totals, buckets)
      addBuckets(dayRow(dayKey(time)), buckets)
      let row = workspaces.get(workspace.id)
      if (row === undefined) {
        row = { id: workspace.id, title: workspace.title ?? '', path: workspace.path ?? '', sessions: 0, ...zeroBuckets() }
        workspaces.set(workspace.id, row)
      }
      addBuckets(row, buckets)
      counted = true
    }
    if (counted) {
      sessionsInRange += 1
      workspaces.get(workspace.id).sessions += 1
    }
  }

  const endKey = range.to !== null ? dayKey(range.to) : dayKey(now)
  let startKey = range.from !== null ? dayKey(range.from) : [...days.keys()].sort()[0]
  if (startKey === undefined) startKey = endKey
  if (startKey > endKey) startKey = endKey
  const series = []
  for (let key = startKey; key <= endKey; key = nextDayKey(key)) {
    series.push(withTotal(dayRow(key)))
    if (series.length >= MAX_DAYS) break
  }

  const workspaceRows = [...workspaces.values()]
    .map((row) => withTotal(row))
    .sort((left, right) => right.totalTokens - left.totalTokens || left.title.localeCompare(right.title))

  return {
    generatedAt: now,
    timeZone: effectiveTimeZone,
    range: { from: range.from, to: range.to },
    totals: withTotal(totals),
    days: series,
    workspaces: workspaceRows,
    sessions: sessionsInRange,
  }
}

/**
 * Bound concurrent session reads without a dependency.
 * @param items - work items.
 * @param limit - maximum concurrent workers.
 * @param worker - async per-item work.
 * @returns one result per item in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function fingerprintOf(header) {
  return `${header?.createdAt ?? ''}|${header?.cwd ?? ''}|${header?.isSeeded === true ? 1 : 0}`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the process-local collector: per-Session replay cache invalidated by
 * the live `session/event` feed.
 * @param ctx - Host context carrying the session query and workspace services.
 * @returns the `collect` entry point used by the data route.
 */
export function createStatsCollector(ctx) {
  const cache = new Map()
  const dirty = new Set()
  const realpaths = new Map()

  if (typeof ctx?.on === 'function') {
    ctx.on('session/event', (session) => {
      if (session?.id !== undefined) dirty.add(session.id)
    })
  }

  const canonical = async (path) => {
    if (typeof path !== 'string' || path === '') return ''
    if (realpaths.has(path)) return realpaths.get(path)
    let resolved = path
    try {
      resolved = await realpath(path)
    } catch {
      /* a removed directory keeps its recorded spelling */
    }
    realpaths.set(path, resolved)
    return resolved
  }

  const workspaceFor = async (header, headers, byPath) => {
    let cwd = header.cwd
    let current = header
    const seen = new Set([header.id])
    while ((typeof cwd !== 'string' || cwd === '') && current?.parentSession !== undefined) {
      if (seen.has(current.parentSession)) break
      seen.add(current.parentSession)
      current = headers.get(current.parentSession)
      if (current === undefined) break
      cwd = current.cwd
    }
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const resolved = await canonical(cwd)
    return byPath.get(resolved) ?? byPath.get(cwd) ?? {
      id: `cwd:${resolved}`,
      title: basename(resolved) || resolved,
      path: resolved,
    }
  }

  const collect = async (options = {}) => {
    const { from = null, to = null, timeZone = 'UTC', refresh = false, signal, now = Date.now() } = options
    if (refresh) {
      cache.clear()
      dirty.clear()
      realpaths.clear()
    }
    const query = ctx?.get?.('sessionQuery')
    if (
      query === undefined ||
      query === null ||
      typeof query.listSessions !== 'function' ||
      typeof query.readSession !== 'function'
    ) {
      throw new StatsUnavailableError('this dsh version does not expose the session query service')
    }
    const listed = await query.listSessions(signal)
    signal?.throwIfAborted?.()
    const headers = new Map(listed.map((record) => [record.header.id, record.header]))
    const visible = new Set(headers.keys())
    for (const id of [...cache.keys()]) {
      if (!visible.has(id)) cache.delete(id)
    }

    const stale = []
    for (const record of listed) {
      const header = record.header
      const cached = cache.get(header.id)
      if (cached !== undefined && cached.fingerprint === fingerprintOf(header) && !dirty.has(header.id)) continue
      stale.push(header)
    }
    for (const header of stale) dirty.delete(header.id)

    await mapLimit(stale, SESSION_READ_CONCURRENCY, async (header) => {
      try {
        const snapshot = await query.readSession(header.id)
        const settled = snapshot.session ?? header
        cache.set(header.id, {
          fingerprint: fingerprintOf(settled),
          header: settled,
          attempts: foldSessionUsage(snapshot.events, snapshot.inheritedEventCount),
          error: undefined,
        })
      } catch (error) {
        cache.set(header.id, {
          fingerprint: fingerprintOf(header),
          header,
          attempts: [],
          error: messageOf(error),
        })
      }
    })

    const registry = ctx?.get?.('workspaceRegistry')
    let workspaceList = []
    try {
      if (typeof registry?.list === 'function') workspaceList = registry.list()
    } catch {
      workspaceList = []
    }
    const bySession = new Map()
    const byPath = new Map()
    for (const workspace of workspaceList ?? []) {
      if (workspace?.path !== undefined) byPath.set(workspace.path, workspace)
      for (const id of workspace?.sessionIds ?? []) bySession.set(id, workspace)
    }

    let skippedSessions = 0
    const sessions = []
    for (const record of listed) {
      const cached = cache.get(record.header.id)
      if (cached?.error !== undefined) skippedSessions += 1
      const header = cached?.header ?? record.header
      let workspace = bySession.get(header.id)
      if (workspace === undefined) workspace = await workspaceFor(header, headers, byPath)
      sessions.push({
        header,
        attempts: cached?.attempts ?? [],
        workspace:
          workspace === undefined
            ? undefined
            : { id: workspace.id, title: workspace.title, path: workspace.path },
      })
    }

    return {
      ...buildStats({ sessions, from, to, timeZone, now }),
      scannedSessions: listed.length,
      skippedSessions,
    }
  }

  return { collect }
}

/**
 * Parse route query parameters; malformed numbers degrade to "unbounded" so a
 * stale URL never fails the panel.
 * @param searchParams - request URL search parameters.
 * @returns collector options.
 */
export function parseStatsQuery(searchParams) {
  const number = (value) => {
    if (value === null || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  const timeZone = (searchParams.get('tz') ?? '').trim() || 'UTC'
  return {
    from: number(searchParams.get('from')),
    to: number(searchParams.get('to')),
    timeZone,
    refresh: searchParams.get('refresh') === '1',
  }
}

/**
 * Whether a request carries the trusted-authority and launch-token session
 * checks the stock `/api` fence applies.
 * @param ctx - Host context.
 * @param request - incoming HTTP request.
 * @returns true when the route may answer with usage data.
 */
export function requestAuthorized(ctx, request) {
  const connection = ctx?.get?.('connection')
  if (connection === undefined || connection === null) return false
  if (typeof connection.isTrusted === 'function') {
    if (connection.isTrusted(request) !== true) return false
  } else if (typeof connection.requestRejection === 'function') {
    if (connection.requestRejection(request) === 403) return false
  }
  const auth = connection.browserAuth
  if (auth === null || typeof auth !== 'object' || typeof auth.isAuthenticated !== 'function') return false
  const secure = ctx?.get?.('webServer')?.protocol === 'https:'
  return auth.isAuthenticated(request, secure) === true
}

function writeJson(response, status, body) {
  if (response.writableEnded === true || response.destroyed === true) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

async function handleStatsRequest(ctx, collector, request, response) {
  try {
    if (request.method !== 'GET') return writeJson(response, 405, { error: 'method-not-allowed' })
    if (!requestAuthorized(ctx, request)) return writeJson(response, 401, { error: 'unauthorized' })
    const controller = new AbortController()
    response.on?.('close', () => {
      if (response.writableEnded !== true) controller.abort()
    })
    const params = parseStatsQuery(new URL(request.url ?? '/', 'http://dsh.invalid').searchParams)
    const data = await collector.collect({ ...params, signal: controller.signal })
    writeJson(response, 200, data)
  } catch (error) {
    const unavailable = error instanceof StatsUnavailableError
    writeJson(response, unavailable ? 503 : 500, {
      error: unavailable ? 'stats-unavailable' : 'stats-failed',
      message: messageOf(error),
    })
  }
}

/**
 * Register the read-only statistics data route.
 * @param ctx - Host context.
 * @param collector - collector returned by {@link createStatsCollector}.
 * @param config - plugin config; `statsPage: false` disables the feature.
 * @returns true when the route was registered.
 */
export function installStatsRoute(ctx, collector, config) {
  if (config?.statsPage === false) return false
  const webServer = ctx?.get?.('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return false
  const handler = (request, response) => {
    void handleStatsRequest(ctx, collector, request, response)
  }
  const register = () => webServer.register({ kind: 'exact', path: STATS_DATA_PATH, handler })
  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-remote-access: token statistics route')
  } else {
    register()
  }
  return true
}
