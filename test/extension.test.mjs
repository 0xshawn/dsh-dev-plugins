import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, test } from 'node:test'

import { BRIDGE_DEFAULT_TOKEN } from '../bridge/config.js'

const BACKGROUND_URL = new URL('../extension/background.js', import.meta.url)
const BACKGROUND_SOURCE = readFileSync(BACKGROUND_URL, 'utf8')

/** Mock chrome API: just enough surface for background.js plus call recording. */
function createChrome() {
  const calls = []
  const storageData = new Map()
  const listeners = {
    onMessage: [],
    onInstalled: [],
    onStartup: [],
    debuggerOnEvent: [],
    debuggerOnDetach: [],
    tabsOnRemoved: [],
    alarmsOnAlarm: [],
  }

  const chrome = {
    calls,
    storageData,
    listeners,
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '0.7.2' }),
      onMessage: { addListener: (listener) => listeners.onMessage.push(listener) },
      onInstalled: { addListener: (listener) => listeners.onInstalled.push(listener) },
      onStartup: { addListener: (listener) => listeners.onStartup.push(listener) },
    },
    debugger: {
      getTargets: async () => [],
      attach: async (target, protocolVersion) => {
        calls.push(['debugger.attach', target, protocolVersion])
      },
      detach: async (target) => {
        calls.push(['debugger.detach', target])
      },
      sendCommand: async (target, method, params) => {
        calls.push(['debugger.sendCommand', target, method, params])
        return {}
      },
      onEvent: { addListener: (listener) => listeners.debuggerOnEvent.push(listener) },
      onDetach: { addListener: (listener) => listeners.debuggerOnDetach.push(listener) },
    },
    tabs: {
      update: async (tabId, properties) => {
        calls.push(['tabs.update', tabId, properties])
        return { id: tabId, ...properties }
      },
      create: async (properties) => {
        calls.push(['tabs.create', properties])
        return { id: 42, ...properties }
      },
      remove: async (tabId) => {
        calls.push(['tabs.remove', tabId])
      },
      onRemoved: { addListener: (listener) => listeners.tabsOnRemoved.push(listener) },
    },
    downloads: {
      search: async (query) => {
        calls.push(['downloads.search', query])
        return []
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === null || keys === undefined) return Object.fromEntries(storageData)
          if (typeof keys === 'string') return storageData.has(keys) ? { [keys]: storageData.get(keys) } : {}
          if (Array.isArray(keys)) {
            const found = {}
            for (const key of keys) if (storageData.has(key)) found[key] = storageData.get(key)
            return found
          }
          const found = { ...keys }
          for (const key of Object.keys(keys)) if (storageData.has(key)) found[key] = storageData.get(key)
          return found
        },
        set: async (items) => {
          calls.push(['storage.set', { ...items }])
          for (const [key, value] of Object.entries(items)) storageData.set(key, value)
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys]
          for (const key of list) storageData.delete(key)
        },
      },
    },
    alarms: {
      create: (name, info) => {
        calls.push(['alarms.create', name, info])
      },
      onAlarm: { addListener: (listener) => listeners.alarmsOnAlarm.push(listener) },
    },
  }
  return chrome
}

/** A fake bridge socket; the worker drives it through the normal event handlers. */
class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  receive(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.readyState = 3
  }

  /** Simulate a server-side close (readyState already OPEN). */
  serverClose(code = 1006, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const chrome = createChrome()
new Function('chrome', BACKGROUND_SOURCE)(chrome)
const seam = globalThis.__dshBrowserBridgeTest

/** Restore the mock chrome methods and recorded calls for one test. */
function resetMock() {
  chrome.calls.length = 0
  chrome.storageData.clear()
  chrome.debugger.getTargets = async () => []
  chrome.debugger.attach = async (target, protocolVersion) => {
    chrome.calls.push(['debugger.attach', target, protocolVersion])
  }
  chrome.debugger.detach = async (target) => {
    chrome.calls.push(['debugger.detach', target])
  }
  chrome.debugger.sendCommand = async (target, method, params) => {
    chrome.calls.push(['debugger.sendCommand', target, method, params])
    return {}
  }
  chrome.tabs.update = async (tabId, properties) => {
    chrome.calls.push(['tabs.update', tabId, properties])
    return { id: tabId, ...properties }
  }
  chrome.tabs.create = async (properties) => {
    chrome.calls.push(['tabs.create', properties])
    return { id: 42, ...properties }
  }
  chrome.tabs.remove = async (tabId) => {
    chrome.calls.push(['tabs.remove', tabId])
  }
  chrome.downloads.search = async (query) => {
    chrome.calls.push(['downloads.search', query])
    return []
  }
}

/** Reset the worker and the mock between tests. */
function resetHarness() {
  seam.resetState()
  seam.setWebSocketImpl(undefined)
  FakeWebSocket.instances = []
  resetMock()
}

/** Send one popup message through the registered onMessage listener. */
function callPopup(message) {
  const listener = chrome.listeners.onMessage[0]
  return new Promise((resolve) => {
    listener(message, {}, resolve)
  })
}

/** Attach one tab through the RPC path, with page metadata from getTargets. */
async function attachTab(tabId) {
  chrome.debugger.getTargets = async () => [
    {
      id: `T${tabId}`,
      type: 'page',
      tabId,
      url: `https://example.test/${tabId}`,
      title: `tab ${tabId}`,
      attached: false,
    },
  ]
  const reply = await seam.handleRpc({ type: 'rpc', id: 900, method: 'attach', params: { tabId } }, chrome)
  assert.equal(reply.type, 'rpc-result')
  return reply
}

beforeEach(() => {
  resetHarness()
})

afterEach(() => {
  seam.resetState()
  seam.setWebSocketImpl(undefined)
  FakeWebSocket.instances = []
})

test('the built-in token connects without any pairing step', async () => {
  seam.setWebSocketImpl(FakeWebSocket)
  seam.resetState()
  assert.equal(seam.getState().usesDefaultToken, true)
  assert.equal(seam.getState().token, '')

  assert.equal(seam.DEFAULT_TOKEN, BRIDGE_DEFAULT_TOKEN)
  const loaded = await seam.loadSettings()
  assert.equal(loaded, undefined)
  assert.equal(seam.connect(), true)
  const ws = FakeWebSocket.instances[0]
  assert.equal(ws.url.endsWith(`?token=${encodeURIComponent(seam.DEFAULT_TOKEN)}`), true)

  // Saving a blank override keeps the built-in token and stores an empty
  // override, so a future built-in-token change would still apply.
  ws.serverClose(1006, 'network')
  await seam.saveSettings('   ', 8790)
  assert.equal(seam.getState().usesDefaultToken, true)
  assert.equal(chrome.storageData.get('token'), '')
  await seam.connect()
  const next = FakeWebSocket.instances.at(-1)
  assert.equal(next.url.endsWith(`?token=${encodeURIComponent(seam.DEFAULT_TOKEN)}`), true)

  // A stored override still wins.
  await seam.saveSettings('custom-token', 8790)
  assert.equal(seam.getState().usesDefaultToken, false)
})

test('a legacy random pairing token is cleared during the upgrade', async () => {
  seam.setWebSocketImpl(FakeWebSocket)
  chrome.storageData.set('token', 'a'.repeat(64))
  chrome.storageData.set('port', 8790)
  seam.resetState()
  await seam.loadSettings()
  assert.equal(seam.getState().usesDefaultToken, true)
  assert.equal(chrome.storageData.has('token'), false)
  assert.equal(seam.connect(), true)
  const ws = FakeWebSocket.instances.at(-1)
  assert.equal(ws.url.endsWith(`?token=${encodeURIComponent(seam.DEFAULT_TOKEN)}`), true)
})

test('parseServerUrl encodes the token and uses the port', () => {
  const url = seam.parseServerUrl(8791, 'a b&c')
  assert.equal(url, 'ws://127.0.0.1:8791/extension?token=a%20b%26c')
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'ws:')
  assert.equal(parsed.hostname, '127.0.0.1')
  assert.equal(parsed.port, '8791')
  assert.equal(parsed.pathname, '/extension')
  assert.equal(parsed.searchParams.get('token'), 'a b&c')

  assert.equal(seam.parseServerUrl(undefined, 't'), 'ws://127.0.0.1:8790/extension?token=t')
  assert.equal(seam.parseServerUrl('not-a-port', 't'), 'ws://127.0.0.1:8790/extension?token=t')
  assert.equal(seam.parseServerUrl(70000, 't'), 'ws://127.0.0.1:8790/extension?token=t')
})

test('backoffDelay grows, caps at 10 s, and restarts from the base delay', () => {
  assert.equal(seam.backoffDelay(0, 0.5), 500)
  assert.equal(seam.backoffDelay(1, 0.5), 1000)
  assert.equal(seam.backoffDelay(2, 0.5), 2000)
  assert.equal(seam.backoffDelay(3, 0.5), 4000)
  assert.equal(seam.backoffDelay(4, 0.5), 8000)
  assert.equal(seam.backoffDelay(5, 0.5), 10000)
  assert.equal(seam.backoffDelay(20, 0.5), 10000)
  assert.equal(seam.backoffDelay(-1, 0.5), 500)
  // Jitter stays inside ±20 % and never exceeds the cap.
  assert.equal(seam.backoffDelay(0, 0), 400)
  assert.equal(seam.backoffDelay(0, 1), 600)
  assert.equal(seam.backoffDelay(20, 1), 10000)
  // Stateless: after the cap the sequence restarts at 500 ms.
  assert.equal(seam.backoffDelay(0, 0.5), 500)
})

test('parseChord and nextState cover the exposed constant maps', () => {
  assert.deepEqual(seam.parseChord(0), { alt: false, ctrl: false, meta: false, shift: false })
  assert.deepEqual(seam.parseChord(1 | 4 | 8), { alt: true, ctrl: false, meta: true, shift: true })
  assert.deepEqual(seam.parseChord(2), { alt: false, ctrl: true, meta: false, shift: false })
  assert.deepEqual(seam.CHORD_MODIFIERS, { alt: 1, ctrl: 2, meta: 4, shift: 8 })
  assert.equal(seam.ERROR_CODES.attachFailed, 'attach_failed')

  const base = { token: seam.DEFAULT_TOKEN, port: seam.DEFAULT_PORT, connected: false, attached: new Map(), lastError: null }
  const welcome = seam.nextState(base, { type: 'welcome' })
  assert.equal(welcome.connected, true)
  assert.equal(welcome.lastError, null)
  const closed = seam.nextState(welcome, { type: 'closed', error: 'socket closed' })
  assert.equal(closed.connected, false)
  assert.equal(closed.lastError, 'socket closed')
  assert.equal(base.connected, false)
})

test('targets maps getTargets output and filters non-page targets', async () => {
  chrome.debugger.getTargets = async () => [
    { id: 'PAGE1', type: 'page', tabId: 1, url: 'https://one.test/', title: 'One', attached: false },
    { id: 'WORKER1', type: 'worker', tabId: 1, url: 'https://one.test/worker.js', title: 'Worker', attached: false },
    { id: 'PAGE2', type: 'page', tabId: 2, url: 'about:blank', title: '', attached: true },
    { id: 'BACKGROUND', type: 'background_page', url: 'chrome-extension://x/bg.html' },
    null,
  ]
  const reply = await seam.handleRpc({ type: 'rpc', id: 31, method: 'targets', params: {} }, chrome)
  assert.equal(reply.type, 'rpc-result')
  assert.equal(reply.id, 31)
  assert.deepEqual(reply.result.targets, [
    { targetId: 'PAGE1', tabId: 1, url: 'https://one.test/', title: 'One', type: 'page', attached: false },
    { targetId: 'PAGE2', tabId: 2, url: 'about:blank', title: '', type: 'page', attached: true },
  ])
})

test('attach is idempotent, adds to the attached set, and reports failures', async () => {
  chrome.debugger.getTargets = async () => [
    { id: 'T7', type: 'page', tabId: 7, url: 'https://example.test/7', title: 'seven', attached: true },
  ]
  const emitted = []
  const first = await seam.handleRpc(
    { type: 'rpc', id: 1, method: 'attach', params: { tabId: 7 } },
    chrome,
    (event) => emitted.push(event),
  )
  assert.equal(first.type, 'rpc-result')
  assert.equal(first.id, 1)
  assert.deepEqual(emitted, [{ tabId: 7, method: 'attached', params: {} }])
  assert.deepEqual(chrome.calls, [['debugger.attach', { tabId: 7 }, '1.3']])
  assert.deepEqual(seam.getState().attached, [{ tabId: 7, url: 'https://example.test/7', title: 'seven' }])

  const second = await seam.handleRpc({ type: 'rpc', id: 2, method: 'attach', params: { tabId: 7 } }, chrome)
  assert.equal(second.type, 'rpc-result')
  assert.equal(chrome.calls.filter((call) => call[0] === 'debugger.attach').length, 1)

  const status = await seam.handleRpc({ type: 'rpc', id: 3, method: 'status', params: {} }, chrome)
  assert.deepEqual(status.result.attached, [{ tabId: 7, url: 'https://example.test/7', title: 'seven' }])

  chrome.debugger.attach = async () => {
    throw new Error('Another debugger is already attached')
  }
  const failed = await seam.handleRpc({ type: 'rpc', id: 4, method: 'attach', params: { tabId: 8 } }, chrome)
  assert.equal(failed.type, 'rpc-error')
  assert.equal(failed.id, 4)
  assert.equal(failed.error.code, 'attach_failed')
  assert.match(failed.error.message, /debugger/)

  const bad = await seam.handleRpc({ type: 'rpc', id: 5, method: 'attach', params: {} }, chrome)
  assert.equal(bad.error.code, 'bad_request')
})

test('cdp forwards method/params and reports cdp_failed or tab_unavailable', async () => {
  await attachTab(4)
  chrome.debugger.sendCommand = async (target, method, params) => {
    chrome.calls.push(['debugger.sendCommand', target, method, params])
    return { value: 1 }
  }
  const reply = await seam.handleRpc(
    {
      type: 'rpc',
      id: 51,
      method: 'cdp',
      params: { tabId: 4, method: 'Runtime.evaluate', params: { expression: '1 + 1' } },
    },
    chrome,
  )
  assert.deepEqual(reply, { type: 'rpc-result', id: 51, result: { result: { value: 1 } } })
  assert.deepEqual(chrome.calls.find((call) => call[0] === 'debugger.sendCommand'), [
    'debugger.sendCommand',
    { tabId: 4 },
    'Runtime.evaluate',
    { expression: '1 + 1' },
  ])

  chrome.debugger.sendCommand = async () => {
    throw new Error('Target closed')
  }
  const failed = await seam.handleRpc(
    { type: 'rpc', id: 52, method: 'cdp', params: { tabId: 4, method: 'Page.enable', params: {} } },
    chrome,
  )
  assert.equal(failed.type, 'rpc-error')
  assert.equal(failed.id, 52)
  assert.equal(failed.error.code, 'cdp_failed')
  assert.match(failed.error.message, /Target closed/)

  const unknownTab = await seam.handleRpc(
    { type: 'rpc', id: 53, method: 'cdp', params: { tabId: 999, method: 'Page.enable', params: {} } },
    chrome,
  )
  assert.equal(unknownTab.error.code, 'tab_unavailable')
  assert.equal(unknownTab.id, 53)

  const badParams = await seam.handleRpc({ type: 'rpc', id: 54, method: 'cdp', params: { tabId: 4 } }, chrome)
  assert.equal(badParams.error.code, 'bad_request')
})

test('create/close/activate call the right chrome APIs and update state', async () => {
  chrome.debugger.getTargets = async () => [
    { id: 'T42', type: 'page', tabId: 42, url: 'https://new.test/', title: 'new', attached: false },
  ]
  const created = await seam.handleRpc(
    { type: 'rpc', id: 61, method: 'create', params: { url: 'https://new.test/' } },
    chrome,
  )
  assert.deepEqual(created.result, { tabId: 42, targetId: 'T42' })
  assert.deepEqual(chrome.calls.find((call) => call[0] === 'tabs.create')[1], {
    url: 'https://new.test/',
    active: true,
  })

  const activated = await seam.handleRpc({ type: 'rpc', id: 62, method: 'activate', params: { tabId: 42 } }, chrome)
  assert.equal(activated.type, 'rpc-result')
  assert.deepEqual(chrome.calls.find((call) => call[0] === 'tabs.update'), ['tabs.update', 42, { active: true }])

  await attachTab(42)
  const emitted = []
  const closed = await seam.handleRpc(
    { type: 'rpc', id: 63, method: 'close', params: { tabId: 42 } },
    chrome,
    (event) => emitted.push(event),
  )
  assert.equal(closed.type, 'rpc-result')
  assert.deepEqual(chrome.calls.find((call) => call[0] === 'tabs.remove'), ['tabs.remove', 42])
  assert.deepEqual(seam.getState().attached, [])
  assert.deepEqual(emitted, [{ tabId: 42, method: 'detached', params: { reason: 'closed' } }])

  chrome.tabs.remove = async () => {
    throw new Error('No tab with id: 999')
  }
  const failed = await seam.handleRpc({ type: 'rpc', id: 64, method: 'close', params: { tabId: 999 } }, chrome)
  assert.equal(failed.error.code, 'tab_unavailable')
})

test('debugger events are forwarded only for attached tabs', async () => {
  await attachTab(5)
  const frames = []
  seam.setSender((text) => {
    frames.push(JSON.parse(text))
    return true
  })

  const onEvent = chrome.listeners.debuggerOnEvent[0]
  onEvent({ tabId: 5 }, 'Network.requestWillBeSent', { requestId: 'r1' })
  assert.deepEqual(frames[0], {
    type: 'event',
    channel: 'debugger',
    payload: { tabId: 5, method: 'Network.requestWillBeSent', params: { requestId: 'r1' } },
  })

  onEvent({ tabId: 6 }, 'Page.loadEventFired', {})
  assert.equal(frames.length, 1)

  chrome.listeners.tabsOnRemoved[0](5)
  assert.deepEqual(seam.getState().attached, [])
  assert.deepEqual(frames[1].payload, { tabId: 5, method: 'detached', params: { reason: 'tab_closed' } })
  onEvent({ tabId: 5 }, 'Page.loadEventFired', {})
  assert.equal(frames.length, 2)

  await attachTab(9)
  chrome.listeners.debuggerOnDetach[0]({ tabId: 9 }, 'target_closed')
  assert.deepEqual(frames[2].payload, { tabId: 9, method: 'detached', params: { reason: 'target_closed' } })
  chrome.listeners.debuggerOnDetach[0]({ tabId: 9 }, 'target_closed')
  assert.equal(frames.length, 3)
})

test('hello is sent with protocol 1 and the extension id after open', async () => {
  seam.setWebSocketImpl(FakeWebSocket)
  await seam.saveSettings('token-1', 8791)
  assert.equal(seam.connect(), true)
  assert.equal(FakeWebSocket.instances.length, 1)
  const ws = FakeWebSocket.instances[0]
  assert.equal(ws.url, 'ws://127.0.0.1:8791/extension?token=token-1')

  ws.open()
  assert.deepEqual(ws.sent[0], {
    type: 'hello',
    protocol: 1,
    extensionId: 'test-extension-id',
    version: '0.7.2',
  })
  assert.equal(seam.getState().connected, false)

  ws.receive({ type: 'welcome', protocol: 1, bridgeVersion: '0.7.2' })
  assert.equal(seam.getState().connected, true)
  assert.equal(seam.getState().lastError, null)

  // A server close bumps the backoff attempt; a later welcome resets it.
  ws.serverClose(1006, 'network')
  assert.equal(seam.getState().connected, false)
  assert.equal(seam.getReconnectAttempt(), 1)
  await seam.connect()
  const next = FakeWebSocket.instances.at(-1)
  assert.notEqual(next, ws)
  next.open()
  next.receive({ type: 'welcome', protocol: 1, bridgeVersion: '0.7.2' })
  assert.equal(seam.getReconnectAttempt(), 0)
})

test('a mismatched welcome marks the connection failed', async () => {
  seam.setWebSocketImpl(FakeWebSocket)
  await seam.saveSettings('token-2', 8790)
  assert.equal(seam.connect(), true)
  const ws = FakeWebSocket.instances[0]
  ws.open()
  ws.receive({ type: 'welcome', protocol: 2, bridgeVersion: '9.0.0' })
  const state = seam.getState()
  assert.equal(state.connected, false)
  assert.match(state.lastError, /protocol/i)
  assert.equal(ws.readyState, 3)
})

test('a missing welcome marks the connection failed', async () => {
  seam.setWebSocketImpl(FakeWebSocket)
  await seam.saveSettings('token-3', 8790)
  seam.setHandshakeTimeout(10)
  assert.equal(seam.connect(), true)
  const ws = FakeWebSocket.instances[0]
  ws.open()
  assert.equal(ws.sent[0].type, 'hello')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const state = seam.getState()
  assert.equal(state.connected, false)
  assert.match(state.lastError, /welcome/i)
  assert.equal(ws.readyState, 3)
})

test('popup get-state/save-settings go through chrome.storage', async () => {
  const initial = await callPopup({ type: 'get-state' })
  assert.equal(initial.ok, true)
  assert.equal(initial.state.connected, false)
  assert.equal(initial.state.port, seam.DEFAULT_PORT)
  assert.deepEqual(initial.state.attached, [])

  const saved = await callPopup({ type: 'save-settings', token: 'tok-9', port: 8890 })
  assert.equal(saved.ok, true)
  const storageSet = chrome.calls.find((call) => call[0] === 'storage.set')
  assert.deepEqual(storageSet[1], { token: 'tok-9', port: 8890 })
  assert.equal(chrome.storageData.get('token'), 'tok-9')
  assert.equal(chrome.storageData.get('port'), 8890)

  const after = await callPopup({ type: 'get-state' })
  assert.equal(after.state.token, 'tok-9')
  assert.equal(after.state.port, 8890)

  const unknown = await callPopup({ type: 'not-a-popup-message' })
  assert.equal(unknown.ok, false)
})

test('downloads op list maps chrome.downloads.search output and passes the limit', async () => {
  const searched = []
  chrome.downloads.search = async (query) => {
    searched.push(query)
    return [
      {
        id: 7,
        url: 'https://example.test/file.zip',
        finalUrl: 'https://example.test/file.zip',
        filename: '/tmp/Downloads/file.zip',
        state: 'complete',
        bytesReceived: 1024,
        totalBytes: 1024,
      },
      {
        id: 8,
        url: 'https://example.test/b.png',
        finalUrl: '',
        filename: '/tmp/Downloads/b.png',
        state: 'in_progress',
        bytesReceived: 5,
        totalBytes: 20,
      },
    ]
  }

  const reply = await seam.handleRpc(
    { type: 'rpc', id: 71, method: 'downloads', params: { op: 'list', limit: 5 } },
    chrome,
  )
  assert.equal(reply.type, 'rpc-result')
  assert.equal(reply.id, 71)
  assert.deepEqual(searched, [{ limit: 5, orderBy: ['-startTime'] }])
  assert.deepEqual(reply.result.downloads, [
    {
      guid: '7',
      url: 'https://example.test/file.zip',
      filename: '/tmp/Downloads/file.zip',
      path: '/tmp/Downloads/file.zip',
      state: 'complete',
      bytesReceived: 1024,
      totalBytes: 1024,
    },
    {
      guid: '8',
      url: 'https://example.test/b.png',
      filename: '/tmp/Downloads/b.png',
      path: '/tmp/Downloads/b.png',
      state: 'in_progress',
      bytesReceived: 5,
      totalBytes: 20,
    },
  ])

  // The default limit is 20 when the bridge omits or mistypes it.
  const defaulted = await seam.handleRpc(
    { type: 'rpc', id: 72, method: 'downloads', params: { op: 'list' } },
    chrome,
  )
  assert.equal(defaulted.type, 'rpc-result')
  assert.deepEqual(searched.at(-1), { limit: 20, orderBy: ['-startTime'] })
  const mistyped = await seam.handleRpc(
    { type: 'rpc', id: 73, method: 'downloads', params: { op: 'list', limit: '3' } },
    chrome,
  )
  assert.equal(mistyped.type, 'rpc-result')
  assert.deepEqual(searched.at(-1), { limit: 20, orderBy: ['-startTime'] })
})

test('downloads maps search failures to download_failed and unknown ops to bad_request', async () => {
  chrome.downloads.search = async () => {
    throw new Error('downloads API unavailable')
  }
  const failed = await seam.handleRpc({ type: 'rpc', id: 74, method: 'downloads', params: { op: 'list' } }, chrome)
  assert.equal(failed.type, 'rpc-error')
  assert.equal(failed.id, 74)
  assert.equal(failed.error.code, 'download_failed')
  assert.match(failed.error.message, /downloads API unavailable/)

  const badOp = await seam.handleRpc({ type: 'rpc', id: 75, method: 'downloads', params: { op: 'open' } }, chrome)
  assert.equal(badOp.type, 'rpc-error')
  assert.equal(badOp.error.code, 'bad_request')
  assert.match(badOp.error.message, /open/)

  const missingOp = await seam.handleRpc({ type: 'rpc', id: 76, method: 'downloads', params: {} }, chrome)
  assert.equal(missingOp.error.code, 'bad_request')
})

