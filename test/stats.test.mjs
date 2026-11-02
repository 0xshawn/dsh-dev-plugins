import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildStats,
  createStatsCollector,
  foldSessionUsage,
  installStatsRoute,
  isTrustedRequest,
  parseStatsQuery,
  requestAuthorized,
  STATS_DATA_PATH,
  StatsUnavailableError,
} from '../lib/stats.js'

const DAY = 86400000

function message(seq, time, turn, step, usage) {
  return { type: 'assistant/message', seq, time, data: { turn, step, usage } }
}

function fakeContext(services = {}) {
  const listeners = []
  return {
    get: (service) => services[service],
    on: (event, listener) => {
      if (event === 'session/event') listeners.push(listener)
    },
    effect: (callback) => callback(),
    emit: (event, ...args) => {
      for (const listener of listeners) listener(...args)
    },
  }
}

function responseSink() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
      this.writableEnded = true
    },
  }
}

function authorizedContext() {
  return fakeContext({
    connection: { isTrusted: () => true, browserAuth: { isAuthenticated: () => true } },
    webServer: { protocol: 'http:' },
  })
}

test('foldSessionUsage keeps the latest sample per Turn/step and skips the inherited prefix', () => {
  const events = [
    message(0, 1000, 1, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    message(1, 2000, 1, 1, { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    message(2, 3000, 1, 2, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 25, cacheWriteTokens: 0 }),
    { type: 'turn/end', seq: 3, time: 4000, data: { turn: 1 } },
  ]
  const claims = foldSessionUsage(events, 0)
  assert.equal(claims.length, 2)
  assert.deepEqual(claims[0], {
    time: 2000,
    buckets: { uncachedInputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })
  const inherited = foldSessionUsage(events, 2)
  assert.equal(inherited.length, 1)
  assert.equal(inherited[0].time, 3000)
})

test('foldSessionUsage reads usage from compact Assistant streams', () => {
  const attempt = {
    type: 'assistant/attempt',
    seq: 0,
    time: 1000,
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'text-chunks', texts: ['hello'] },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } } },
      ],
    },
  }
  const claims = foldSessionUsage([attempt])
  assert.equal(claims.length, 1)
  assert.deepEqual(claims[0].buckets, {
    uncachedInputTokens: 7,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('foldSessionUsage adds the retried attempt after a retry boundary', () => {
  const events = [
    message(0, 1000, 1, 1, { inputTokens: 100, outputTokens: 10 }),
    { type: 'llm/retry-started', seq: 1, time: 1100, data: { turn: 1, step: 1 } },
    message(2, 2000, 1, 1, { inputTokens: 40, outputTokens: 4 }),
  ]
  const claims = foldSessionUsage(events)
  assert.equal(claims.length, 2)
  assert.deepEqual(
    claims.map((claim) => claim.buckets.uncachedInputTokens).sort((left, right) => left - right),
    [40, 100],
  )
})

test('buildStats fills a day series, filters the range, and groups workspaces', () => {
  const sessions = [
    {
      header: { id: 'a' },
      workspace: { id: 'ws-a', title: 'Alpha', path: '/code/alpha' },
      attempts: [
        { time: Date.parse('2026-10-31T10:00:00Z'), buckets: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        { time: Date.parse('2026-11-01T10:00:00Z'), buckets: { uncachedInputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      ],
    },
    {
      header: { id: 'b' },
      workspace: { id: 'ws-b', title: 'Beta', path: '/code/beta' },
      attempts: [
        { time: Date.parse('2026-11-01T11:00:00Z'), buckets: { uncachedInputTokens: 5, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 } },
      ],
    },
  ]
  const stats = buildStats({
    sessions,
    from: Date.parse('2026-10-31T00:00:00Z'),
    to: Date.parse('2026-11-01T23:59:59Z'),
    timeZone: 'UTC',
    now: Date.parse('2026-11-01T12:00:00Z'),
  })
  assert.deepEqual(stats.days.map((day) => day.date), ['2026-10-31', '2026-11-01'])
  assert.equal(stats.days[0].totalTokens, 110)
  assert.equal(stats.days[1].totalTokens, 227)
  assert.equal(stats.totals.totalTokens, 337)
  assert.equal(stats.sessions, 2)
  assert.deepEqual(stats.workspaces.map((row) => row.id), ['ws-a', 'ws-b'])
  assert.equal(stats.workspaces[0].sessions, 1)
  assert.equal(stats.workspaces[0].totalTokens, 330)
})

test('buildStats buckets by the requested local day and falls back to UTC', () => {
  const attempt = {
    time: Date.parse('2026-11-01T16:30:00Z'),
    buckets: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }
  const shanghai = buildStats({
    sessions: [{ workspace: { id: 'w', title: 'W', path: '/w' }, attempts: [attempt] }],
    from: Date.parse('2026-11-01T00:00:00Z'),
    to: Date.parse('2026-11-03T00:00:00Z'),
    timeZone: 'Asia/Shanghai',
    now: Date.parse('2026-11-02T00:00:00Z'),
  })
  assert.equal(shanghai.timeZone, 'Asia/Shanghai')
  assert.equal(shanghai.days[1].date, '2026-11-02')
  assert.equal(shanghai.days[1].totalTokens, 2)
  const invalid = buildStats({ sessions: [], timeZone: 'Not/AZone', now: Date.now() })
  assert.equal(invalid.timeZone, 'UTC')
  assert.equal(invalid.days.length, 1)
})

test('buildStats keeps sessions without a workspace under one unknown row', () => {
  const stats = buildStats({
    sessions: [
      {
        attempts: [{ time: Date.now(), buckets: { uncachedInputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
      },
    ],
    timeZone: 'UTC',
  })
  assert.equal(stats.workspaces.length, 1)
  assert.equal(stats.workspaces[0].id, 'unknown')
  assert.equal(stats.workspaces[0].totalTokens, 3)
})

test('parseStatsQuery degrades malformed values to unbounded and reads refresh', () => {
  assert.deepEqual(parseStatsQuery(new URLSearchParams('')), {
    from: null,
    to: null,
    timeZone: 'UTC',
    refresh: false,
  })
  assert.deepEqual(parseStatsQuery(new URLSearchParams('from=100&to=nope&tz=Asia%2FShanghai&refresh=1')), {
    from: 100,
    to: null,
    timeZone: 'Asia/Shanghai',
    refresh: true,
  })
})

test('isTrustedRequest covers the 0.2.0 rejection-code branch', () => {
  assert.equal(isTrustedRequest({ isTrusted: () => true }, {}), true)
  assert.equal(isTrustedRequest({ requestRejection: () => 401 }, {}), true)
  assert.equal(isTrustedRequest({ requestRejection: () => 403 }, {}), false)
  assert.equal(isTrustedRequest({}, {}), true)
})

test('requestAuthorized enforces the trusted authority and cookie checks', () => {
  assert.equal(requestAuthorized(authorizedContext(), {}), true)
  assert.equal(
    requestAuthorized(
      fakeContext({ connection: { isTrusted: () => false, browserAuth: { isAuthenticated: () => true } } }),
      {},
    ),
    false,
  )
  assert.equal(
    requestAuthorized(
      fakeContext({ connection: { isTrusted: () => true, browserAuth: { isAuthenticated: () => false } } }),
      {},
    ),
    false,
  )
  assert.equal(requestAuthorized(fakeContext({}), {}), false)
})

test('the collector caches whole-log folds and recomputes dirty sessions', async () => {
  const reads = []
  const records = [
    { header: { id: 'a', createdAt: 1, cwd: '/code/alpha', isSeeded: false }, live: false, persisted: true },
    { header: { id: 'b', createdAt: 2, cwd: '/code/beta', isSeeded: false }, live: false, persisted: true },
  ]
  const ctx = fakeContext({
    sessionQuery: {
      listSessions: async () => records,
      readSession: async (id) => {
        reads.push(id)
        return {
          session: records.find((record) => record.header.id === id).header,
          inheritedEventCount: 0,
          events: [message(0, Date.now(), 1, 1, { inputTokens: 10, outputTokens: 1 })],
        }
      },
    },
    workspaceRegistry: {
      list: () => [
        { id: 'ws', title: 'Alpha', path: '/code/alpha', sessionIds: ['a'] },
      ],
    },
  })
  const collector = createStatsCollector(ctx)
  const first = await collector.collect({ timeZone: 'UTC' })
  assert.deepEqual(reads.sort(), ['a', 'b'])
  assert.equal(first.scannedSessions, 2)
  assert.equal(first.workspaces.length, 2)
  const second = await collector.collect({ timeZone: 'UTC' })
  assert.equal(reads.length, 2)
  assert.equal(second.totals.totalTokens, 22)
  ctx.emit('session/event', { id: 'a' }, { type: 'assistant/message' })
  await collector.collect({ timeZone: 'UTC' })
  assert.deepEqual(reads.slice(2), ['a'])
  await collector.collect({ timeZone: 'UTC', refresh: true })
  assert.equal(reads.length, 5)
})

test('a cached read failure retries on the next request', async () => {
  let fail = true
  const ctx = fakeContext({
    sessionQuery: {
      listSessions: async () => [
        { header: { id: 'a', createdAt: 1, cwd: '/code/alpha', isSeeded: false }, live: false, persisted: true },
      ],
      readSession: async (id) => {
        if (fail) throw new Error('temporarily unavailable')
        return {
          session: { id, createdAt: 1, cwd: '/code/alpha', isSeeded: false },
          inheritedEventCount: 0,
          events: [message(0, Date.now(), 1, 1, { inputTokens: 10, outputTokens: 1 })],
        }
      },
    },
  })
  const collector = createStatsCollector(ctx)
  const failed = await collector.collect({ timeZone: 'UTC' })
  assert.equal(failed.skippedSessions, 1)
  assert.equal(failed.totals.totalTokens, 0)
  fail = false
  const recovered = await collector.collect({ timeZone: 'UTC' })
  assert.equal(recovered.skippedSessions, 0)
  assert.equal(recovered.totals.totalTokens, 11)
})

test('the collector resolves a subagent workspace through its parent chain', async () => {
  const records = [
    { header: { id: 'parent', createdAt: 1, cwd: '/code/alpha', isSeeded: false }, live: false, persisted: true },
    { header: { id: 'child', createdAt: 2, parentSession: 'parent', isSeeded: false }, live: false, persisted: true },
  ]
  const ctx = fakeContext({
    sessionQuery: {
      listSessions: async () => records,
      readSession: async (id) => ({
        session: records.find((record) => record.header.id === id).header,
        inheritedEventCount: 0,
        events: [message(0, Date.now(), 1, 1, { inputTokens: 10, outputTokens: 1 })],
      }),
    },
    workspaceRegistry: {
      list: () => [{ id: 'ws', title: 'Alpha', path: '/code/alpha', sessionIds: [] }],
    },
  })
  const collector = createStatsCollector(ctx)
  const stats = await collector.collect({ timeZone: 'UTC' })
  assert.equal(stats.workspaces.length, 1)
  assert.equal(stats.workspaces[0].id, 'ws')
  assert.equal(stats.workspaces[0].sessions, 2)
})

test('the collector reports an unavailable session query service', async () => {
  const collector = createStatsCollector(fakeContext({}))
  await assert.rejects(collector.collect({}), StatsUnavailableError)
})

test('installStatsRoute registers the exact data route and answers JSON', async () => {
  let route
  const ctx = authorizedContext()
  ctx.get = ((get) => (service) => (service === 'webServer' ? {
    protocol: 'http:',
    register: (value) => {
      route = value
      return () => {}
    },
  } : get(service)))(ctx.get)
  assert.equal(installStatsRoute(ctx, { collect: async () => ({ ok: true }) }, {}), true)
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, STATS_DATA_PATH)
  const response = responseSink()
  route.handler({ method: 'GET', url: `${STATS_DATA_PATH}?tz=UTC`, on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('the data route rejects methods and unauthenticated requests', async () => {
  let route
  const ctx = fakeContext({
    connection: { isTrusted: () => true, browserAuth: { isAuthenticated: () => false } },
    webServer: { protocol: 'http:', register: (value) => { route = value; return () => {} } },
  })
  installStatsRoute(ctx, { collect: async () => ({}) }, {})
  const methodResponse = responseSink()
  route.handler({ method: 'POST', url: STATS_DATA_PATH, on: () => {} }, methodResponse)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(methodResponse.status, 405)
  const authResponse = responseSink()
  route.handler({ method: 'GET', url: STATS_DATA_PATH, on: () => {} }, authResponse)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(authResponse.status, 401)
})

test('the data route returns 503 when session query is unavailable', async () => {
  let route
  const ctx = authorizedContext()
  ctx.get = ((get) => (service) => (service === 'webServer' ? {
    protocol: 'http:',
    register: (value) => {
      route = value
      return () => {}
    },
  } : get(service)))(ctx.get)
  installStatsRoute(ctx, createStatsCollector(ctx), {})
  const response = responseSink()
  route.handler({ method: 'GET', url: STATS_DATA_PATH, on: () => {} }, response)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(response.status, 503)
  assert.equal(JSON.parse(response.body).error, 'stats-unavailable')
})

test('installStatsRoute waits for webServer through ctx.inject', () => {
  let route
  const ctx = authorizedContext()
  let injected
  ctx.inject = (dependencies, callback) => {
    injected = dependencies
    callback({
      get: ctx.get,
      effect: (register) => register(),
      webServer: {
        protocol: 'http:',
        register: (value) => {
          route = value
          return () => {}
        },
      },
    })
  }
  assert.equal(installStatsRoute(ctx, { collect: async () => ({}) }, {}), true)
  assert.deepEqual(injected, ['webServer'])
  assert.equal(route.path, STATS_DATA_PATH)
})

test('statsPage: false leaves the data route unregistered', () => {
  assert.equal(installStatsRoute(authorizedContext(), { collect: async () => ({}) }, { statsPage: false }), false)
})

test('a live stats switch answers 404 without re-registering the route', async () => {
  let route
  let enabled = true
  const ctx = authorizedContext()
  ctx.get = ((get) => (service) => (service === 'webServer' ? {
    protocol: 'http:',
    register: (value) => {
      route = value
      return () => {}
    },
  } : get(service)))(ctx.get)
  assert.equal(
    installStatsRoute(ctx, { collect: async () => ({ ok: true }) }, {}, () => enabled),
    true,
  )
  const onResponse = responseSink()
  route.handler({ method: 'GET', url: STATS_DATA_PATH, on: () => {} }, onResponse)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(onResponse.status, 200)
  enabled = false
  const offResponse = responseSink()
  route.handler({ method: 'GET', url: STATS_DATA_PATH, on: () => {} }, offResponse)
  assert.equal(offResponse.status, 404)
  assert.equal(JSON.parse(offResponse.body).error, 'stats-disabled')
})

test('the day series does not exceed the fill cap', () => {
  const stats = buildStats({
    sessions: [],
    from: Date.parse('2000-01-01T00:00:00Z'),
    to: Date.parse('2026-01-01T00:00:00Z'),
    timeZone: 'UTC',
    now: Date.parse('2026-01-01T00:00:00Z'),
  })
  assert.ok(stats.days.length <= 3660)
})
