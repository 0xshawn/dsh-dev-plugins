import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)

/** Load the hand-written client bundle through a fake module loader. */
async function loadClientBundle(requireMap = {}) {
  const source = await readFile(CLIENT_URL, 'utf8')
  let exports
  const window = {
    __ModuleLoader__: {
      load(registration) {
        assert.equal(registration.id, 'dsh-remote-access')
        exports = registration.factory((name) => {
          if (Object.hasOwn(requireMap, name)) return requireMap[name]
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  new Function('window', source)(window)
  return exports
}

class FakeNotification {
  static permission = 'granted'
  static requests = 0
  static sent = []

  constructor(title, options) {
    this.title = title
    this.options = options
    this.closed = false
    FakeNotification.sent.push(this)
  }

  close() {
    this.closed = true
    this.onclose?.()
  }

  static requestPermission() {
    FakeNotification.requests += 1
    return Promise.resolve(FakeNotification.permission)
  }

  static reset(permission = 'granted') {
    FakeNotification.permission = permission
    FakeNotification.requests = 0
    FakeNotification.sent = []
  }
}

function installBrowser(overrides = {}) {
  const previous = {
    Notification: globalThis.Notification,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    config: globalThis.__DSH_REMOTE_ACCESS_NOTIFY__,
  }
  const store = new Map()
  const listeners = new Map()
  const document = {
    visibilityState: overrides.visibilityState ?? 'hidden',
    hasFocus: () => overrides.focused ?? false,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  }
  globalThis.Notification = FakeNotification
  globalThis.document = document
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  delete globalThis.__DSH_REMOTE_ACCESS_NOTIFY__
  if (overrides.config !== undefined) globalThis.__DSH_REMOTE_ACCESS_NOTIFY__ = overrides.config
  return {
    document,
    listeners,
    restore() {
      globalThis.Notification = previous.Notification
      globalThis.document = previous.document
      if (previous.localStorage === undefined) delete globalThis.localStorage
      else globalThis.localStorage = previous.localStorage
      if (previous.config === undefined) delete globalThis.__DSH_REMOTE_ACCESS_NOTIFY__
      else globalThis.__DSH_REMOTE_ACCESS_NOTIFY__ = previous.config
    },
  }
}

function fakeContext(sessions = {}) {
  const listeners = []
  let snapshot = new Map()
  const source = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
  }
  const remoteHandlers = new Map()
  return {
    ctx: {
      uiSession: { sessionStatus: source },
      sessions: {
        list: {
          getSnapshot: () => ({ byId: sessions }),
        },
      },
      remote: {
        $on(key, listener) {
          remoteHandlers.set(key, listener)
          return () => {
            remoteHandlers.delete(key)
          }
        },
      },
      effect(callback) {
        const disposer = callback()
        this.disposers.push(disposer)
      },
      disposers: [],
    },
    push(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    listeners,
    remoteHandlers,
  }
}

function row(title, extra = {}) {
  return { title, ...extra }
}

function sessionContext(rows, subagentIds = []) {
  return {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: rows }),
      },
      subagentAddress: (sessionId) => (subagentIds.includes(sessionId) ? { kind: 'subagent', sessionId } : undefined),
    },
  }
}

test('client bundle exports the Cordis plugin shape', async () => {
  const client = await loadClientBundle()
  assert.equal(client.name, 'dsh-remote-access-notifications')
  assert.deepEqual(client.inject, ['remote', 'sessions', 'uiSession'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(typeof client.__test.handleStatusChange, 'function')
})

test('notifications can be disabled by the host-injected config', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ config: { enabled: false } })
  try {
    assert.equal(client.__test.enabled(), false)
  } finally {
    browser.restore()
  }
})

test('a finished non-subagent session emits one completion notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Fix the deploy') }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Fix the deploy/u)
  assert.match(sent[0].tag, /s1:complete/u)
})

test('an agent error replaces the completion notification and keeps the detail', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Broken model') }
  const errors = new Map()
  client.__test.recordAgentError(errors, 's1', 'DeepSeek request failed: 401 Unauthorized', 1000)
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message), errors, 1000)
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task failed: Broken model/u)
  assert.match(sent[0].body, /401 Unauthorized/u)
  assert.match(sent[0].tag, /s1:error/u)
  assert.equal(errors.size, 0)
})

test('a stale agent error falls back to a completion notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Old failure') }
  const errors = new Map()
  client.__test.recordAgentError(errors, 's1', 'old failure', 1000)
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message), errors, 30000)
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Old failure/u)
  assert.equal(errors.size, 0)
})

test('an unlisted session is not guessed into a notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const previous = new Map([['missing', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['missing', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext({}), (message) => sent.push(message))
  assert.deepEqual(sent, [])
})

test('a team subagent row is skipped by origin/depth without parentSessionId', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = {
    team: row('Team reviewer', { origin: 'subagent' }),
    child: row('Child row', { depth: 1 }),
  }
  const previous = new Map([
    ['team', { running: true, pendingInteraction: undefined }],
    ['child', { running: true, pendingInteraction: undefined }],
  ])
  const next = new Map([
    ['team', { running: false, pendingInteraction: undefined }],
    ['child', { running: false, pendingInteraction: undefined }],
  ])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.deepEqual(sent, [])
})

test('a main-view session still emits for the background visibility gate', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Current task', { retainedBy: { mainView: 1 } }) }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Current task/u)
})

test('a subagent absent from the session list is still skipped', async () => {
  const client = await loadClientBundle()
  const sent = []
  const previous = new Map([['child', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['child', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(
    previous,
    next,
    sessionContext({}, ['child']),
    (message) => sent.push(message),
  )
  assert.deepEqual(sent, [])
})

test('listed subagent and removed sessions are skipped', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = {
    child: row('Child', { parentSessionId: 's1' }),
    gone: row('Gone', { removed: true }),
  }
  const previous = new Map()
  const next = new Map([
    ['child', { running: false, pendingInteraction: undefined }],
    ['gone', { running: false, pendingInteraction: undefined }],
  ])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.deepEqual(sent, [])
})

test('a new pending question emits an input notification', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Review plan') }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', {
    running: true,
    pendingInteraction: { key: 'question-1', kind: 'question', sessionId: 's1' },
  }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Input needed: Review plan/u)
  assert.equal(sent[0].requireInteraction, true)
})

test('an approval notification names the tool and is not repeated for the same request', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Ship it') }
  const pending = { key: 'approval-1', kind: 'approval', toolName: 'bash', sessionId: 's1' }
  const previous = new Map([['s1', { running: true, pendingInteraction: undefined }]])
  const next = new Map([['s1', { running: true, pendingInteraction: pending }]])
  client.__test.handleStatusChange(previous, next, sessionContext(sessions), (message) => sent.push(message))
  assert.match(sent[0].title, /Approval needed: Ship it/u)
  assert.match(sent[0].body, /bash/u)

  const repeated = []
  client.__test.handleStatusChange(next, next, sessionContext(sessions), (message) => repeated.push(message))
  assert.deepEqual(repeated, [])
})

test('a session that finishes after answering does notify completion', async () => {
  const client = await loadClientBundle()
  const sent = []
  const sessions = { s1: row('Demo') }
  const pending = new Map([['s1', {
    running: true,
    pendingInteraction: { key: 'q', kind: 'question', sessionId: 's1' },
  }]])
  const done = new Map([['s1', { running: false, pendingInteraction: undefined }]])
  client.__test.handleStatusChange(pending, done, sessionContext(sessions), (message) => sent.push(message))
  assert.equal(sent.length, 1)
  assert.match(sent[0].title, /Task finished: Demo/u)
})

test('the main session is silent while visible but a background session notifies', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ visibilityState: 'visible', focused: true })
  try {
    assert.equal(client.__test.announce({ title: 'Main', body: 'Body', mainSession: true }), undefined)
    assert.equal(FakeNotification.sent.length, 0)
    const sent = client.__test.announce({ title: 'Background', body: 'Body', mainSession: false })
    assert.equal(sent.title, 'Background')
    assert.equal(FakeNotification.sent.length, 1)
  } finally {
    browser.restore()
  }
})

test('the main session notifies once the page is hidden', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ visibilityState: 'hidden', focused: false })
  try {
    const sent = client.__test.announce({ title: 'Main hidden', body: 'Body', mainSession: true })
    assert.equal(sent.title, 'Main hidden')
  } finally {
    browser.restore()
  }
})

test('announce respects the browser permission', async () => {
  const client = await loadClientBundle()
  FakeNotification.reset('denied')
  const browser = installBrowser()
  try {
    assert.equal(client.__test.announce({ title: 'Blocked', body: 'Body' }), undefined)
    FakeNotification.reset('granted')
    const notification = client.__test.announce({ title: 'Shown', body: 'Body' })
    assert.equal(notification.title, 'Shown')
    assert.equal(FakeNotification.sent.length, 1)
  } finally {
    browser.restore()
  }
})

test('apply subscribes to sessionStatus and notifies after the idle settle delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Background task') })
    client.apply(fixture.ctx)
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    assert.equal(FakeNotification.sent.length, 0)
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 1)
    assert.match(FakeNotification.sent[0].title, /Task finished: Background task/u)
    assert.equal(fixture.ctx.disposers.length, 3)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('permission is requested once on the first gesture', async () => {
  const client = await loadClientBundle()
  FakeNotification.reset('default')
  const browser = installBrowser()
  try {
    client.__test.armPermissionRequest(FakeNotification)
    assert.equal(typeof browser.listeners.get('pointerdown'), 'function')
    browser.listeners.get('pointerdown')()
    browser.listeners.get('keydown')?.()
    assert.equal(FakeNotification.requests, 1)
  } finally {
    browser.restore()
  }
})

test('apply forwards api-session/error into a failure notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Broken task') })
    client.apply(fixture.ctx)
    const onError = fixture.remoteHandlers.get('api-session/error')
    assert.equal(typeof onError, 'function')
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    onError('s1', 'connection reset by peer')
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 1)
    assert.match(FakeNotification.sent[0].title, /Task failed: Broken task/u)
    assert.match(FakeNotification.sent[0].options.body, /connection reset by peer/u)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('a quick retry cancels the pending notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = await loadClientBundle()
  FakeNotification.reset('granted')
  const browser = installBrowser()
  try {
    const fixture = fakeContext({ s1: row('Retrying task') })
    client.apply(fixture.ctx)
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: false, pendingInteraction: undefined }]]))
    fixture.push(new Map([['s1', { running: true, pendingInteraction: undefined }]]))
    t.mock.timers.tick(client.__test.SETTLE_MS)
    assert.equal(FakeNotification.sent.length, 0)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    browser.restore()
  }
})

test('the boot manifest revision is parsed for the stale-page check', async () => {
  const client = await loadClientBundle()
  const html = '<script>globalThis["__DSH_BOOT__"] = {"rev":"boot","entries":[{"id":"other","rev":"x"},{"id":"dsh-remote-access","rev":"plugin-rev"}]}</script>'
  assert.equal(client.__test.parseBootRev(html), 'plugin-rev')
  assert.equal(client.__test.parseBootRev('<html></html>'), undefined)
  assert.equal(client.__test.bootEntryRev({ entries: [{ id: 'dsh-remote-access', rev: 'r' }] }), 'r')
})

test('another focused tab viewing the session suppresses the notification', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ visibilityState: 'visible', focused: true })
  try {
    globalThis.localStorage.setItem('dsh-remote-access:viewing', JSON.stringify({
      pageId: 'other-tab',
      sessionId: 's1',
      focused: true,
      at: Date.now(),
    }))
    assert.equal(client.__test.anotherPageViewing('s1'), true)
    assert.equal(client.__test.anotherPageViewing('s2'), false)
  } finally {
    browser.restore()
  }
})

test('one tab claims a notification event so hidden tabs do not duplicate it', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser()
  try {
    assert.equal(client.__test.claimNotification('s1', 'complete'), true)
    globalThis.localStorage.setItem(
      'dsh-remote-access:claim:s1:complete',
      JSON.stringify({ pageId: 'other-tab', at: Date.now() }),
    )
    assert.equal(client.__test.claimNotification('s1', 'complete'), false)
    assert.equal(client.__test.claimNotification('s1', 'error'), true)
  } finally {
    browser.restore()
  }
})

test('syncViewing publishes the focused main session and currentMainSessionId finds it', async () => {
  const client = await loadClientBundle()
  const browser = installBrowser({ visibilityState: 'visible', focused: true })
  try {
    const context = sessionContext({ s1: row('Main', { retainedBy: { mainView: 1 } }) })
    assert.equal(client.__test.currentMainSessionId(context.sessions), 's1')
    client.__test.syncViewing(context.sessions)
    const record = JSON.parse(globalThis.localStorage.getItem('dsh-remote-access:viewing'))
    assert.equal(record.sessionId, 's1')
    assert.equal(record.focused, true)
  } finally {
    browser.restore()
  }
})

test('apply is a no-op when the browser has no Notification API', async () => {
  const client = await loadClientBundle()
  const previous = globalThis.Notification
  delete globalThis.Notification
  try {
    const fixture = fakeContext()
    client.apply(fixture.ctx)
    assert.equal(fixture.ctx.disposers.length, 0)
  } finally {
    globalThis.Notification = previous
  }
})

test('token counts use compact units', async () => {
  const client = await loadClientBundle()
  assert.equal(client.__test.formatTokens(0), '0')
  assert.equal(client.__test.formatTokens(999), '999')
  assert.equal(client.__test.formatTokens(12345), '12.3K')
  assert.equal(client.__test.formatTokens(3456789), '3.46M')
  assert.equal(client.__test.formatTokens(1200000000), '1.20B')
  assert.equal(client.__test.formatTokens(Number.NaN), '0')
})

test('time presets produce local inclusive ranges', async () => {
  const client = await loadClientBundle()
  const now = new Date(2026, 10, 1, 15, 0, 0).getTime()
  const today = client.__test.rangeForPreset('today', now)
  assert.equal(today.from, new Date(2026, 10, 1, 0, 0, 0, 0).getTime())
  assert.equal(today.to, now)
  const last7 = client.__test.rangeForPreset('7d', now)
  assert.equal(last7.from, new Date(2026, 9, 26, 0, 0, 0, 0).getTime())
  assert.deepEqual(client.__test.rangeForPreset('all', now), { from: null, to: null })
  const custom = client.__test.rangeForPreset('custom', now, '2026-10-01', '2026-10-03')
  assert.equal(custom.from, new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
  assert.equal(custom.to, new Date(2026, 9, 3, 23, 59, 59, 999).getTime())
  assert.deepEqual(client.__test.rangeForPreset('custom', now, 'bad', '2026-10-03'), { from: null, to: null })
  assert.equal(client.__test.parseDateInput('2026-02-30'), undefined)
  assert.equal(client.__test.localDateInputValue(new Date(2026, 0, 2).getTime()), '2026-01-02')
})

test('the data URL keeps the proxy mount prefix and adds query values', async () => {
  const client = await loadClientBundle()
  const url = client.__test.statsDataUrl('https://dsh.example.com/ui/', {
    from: 100,
    to: 200,
    timeZone: 'Asia/Shanghai',
    refresh: true,
  })
  assert.equal(url.pathname, '/ui/dsh-remote-access/stats/data')
  assert.equal(url.searchParams.get('from'), '100')
  assert.equal(url.searchParams.get('to'), '200')
  assert.equal(url.searchParams.get('tz'), 'Asia/Shanghai')
  assert.equal(url.searchParams.get('refresh'), '1')
  const root = client.__test.statsDataUrl('https://dsh.example.com/', {})
  assert.equal(root.pathname, '/dsh-remote-access/stats/data')
})

test('apply registers the statistics panel and its sidebar entry', async () => {
  const client = await loadClientBundle({ react: { createElement: () => undefined } })
  const browser = installBrowser()
  const previous = globalThis.__DSH_REMOTE_ACCESS_STATS__
  delete globalThis.__DSH_REMOTE_ACCESS_STATS__
  try {
    const seats = []
    const registrations = []
    const fixture = fakeContext({ s1: row('Background task') })
    fixture.ctx.slots = {
      inject(seat, callback) {
        seats.push(seat)
        return callback()
      },
      register(registration) {
        registrations.push(registration)
        return () => {}
      },
    }
    fixture.ctx.locale = {
      register: () => () => {},
      bind: () => (key) => key,
    }
    client.apply(fixture.ctx)
    assert.deepEqual(seats, ['main', 'sidebar.panellist'])
    assert.deepEqual(registrations.map((registration) => registration.name), ['main', 'sidebar.panellist'])
    assert.equal(registrations[0].key, 'token-stats')
    assert.equal(registrations[1].id, 'token-stats')
    assert.equal(registrations[1].order, 55)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    if (previous === undefined) delete globalThis.__DSH_REMOTE_ACCESS_STATS__
    else globalThis.__DSH_REMOTE_ACCESS_STATS__ = previous
    browser.restore()
  }
})

test('a disabled host statistics switch installs no panel', async () => {
  const client = await loadClientBundle({ react: { createElement: () => undefined } })
  const browser = installBrowser()
  const previous = globalThis.__DSH_REMOTE_ACCESS_STATS__
  try {
    globalThis.__DSH_REMOTE_ACCESS_STATS__ = { enabled: false }
    const seats = []
    const fixture = fakeContext()
    fixture.ctx.slots = {
      inject(seat, callback) {
        seats.push(seat)
        return callback()
      },
      register: () => () => {},
    }
    fixture.ctx.locale = { register: () => () => {}, bind: () => (key) => key }
    client.apply(fixture.ctx)
    assert.deepEqual(seats, [])
    assert.equal(client.__test.statsEnabled(), false)
    fixture.ctx.disposers.forEach((dispose) => dispose?.())
  } finally {
    if (previous === undefined) delete globalThis.__DSH_REMOTE_ACCESS_STATS__
    else globalThis.__DSH_REMOTE_ACCESS_STATS__ = previous
    browser.restore()
  }
})
