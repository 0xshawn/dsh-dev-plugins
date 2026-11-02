import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { McpServer } from '@modelcontextprotocol/server'
import { WebSocket } from 'ws'

import { auditToolCall, buildAuditLine } from '../bridge/audit.js'
import { ChromeSession } from '../bridge/chrome.js'
import { BRIDGE_DEFAULT_TOKEN, loadConfig, parseConfig, readFeatureState } from '../bridge/config.js'
import { stripSecretValues } from '../bridge/dom.js'
import { saveDownload } from '../bridge/download.js'
import { createNetworkLog, NETWORK_BODY_LIMIT, readNetworkBody, truncateBody } from '../bridge/network.js'
import { createRelay } from '../bridge/relay.js'
import {
  formatKeyChord,
  isWithinRoots,
  MODIFIER_MASKS,
  registerTools,
  resolveUploadPaths,
  selectAllChord,
  summarizeParams,
} from '../bridge/tools.js'

const TOKEN = 'test-token'
const ORIGIN = 'chrome-extension://abc'

function makeConfig(overrides = {}) {
  return {
    port: 0,
    token: TOKEN,
    extensionIds: ['abc'],
    home: join(tmpdir(), 'bridge-test-unused'),
    uploadRoots: [],
    downloadDir: join(tmpdir(), 'bridge-test-downloads'),
    disabledTools: [],
    networkLimit: 500,
    ...overrides,
  }
}

async function startRelay(overrides = {}, options = {}) {
  const relay = createRelay(makeConfig(overrides), { helloTimeoutMs: 300, ...options })
  await relay.listen()
  return relay
}

/** Minimal session stub for invoking tool handlers without a browser. */
function fakeSession(overrides = {}) {
  return {
    activeTabId: 1,
    ensureActiveTab: async () => 1,
    rememberUrl: () => {},
    urlFor: () => undefined,
    pressChord: async () => {},
    send: async () => ({}),
    network: { get: () => undefined, pendingCount: () => 0, list: () => [], size: 0 },
    ...overrides,
  }
}

/** Capture tool handlers by registering them on a fake McpServer. */
function toolHandlers(session, config = {}) {
  const handlers = new Map()
  registerTools(
    { registerTool: (name, toolConfig, callback) => handlers.set(name, callback) },
    session,
    { home: join(tmpdir(), 'bridge-test-audit'), disabledTools: [], ...config },
  )
  return handlers
}

function extensionUrl(relay, token = TOKEN) {
  return `ws://127.0.0.1:${relay.port}/extension?token=${encodeURIComponent(token)}`
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitForClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  })
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for a WebSocket message'))
    }, timeoutMs)
    const onMessage = (data) => {
      const message = JSON.parse(data.toString())
      if (predicate(message)) {
        clearTimeout(timer)
        socket.off('message', onMessage)
        resolve(message)
      }
    }
    socket.on('message', onMessage)
  })
}

/**
 * Connect a fake extension that completes hello/welcome and answers `targets`
 * with one page target (all other RPCs get an empty result).
 */
async function connectFakeExtension(relay, { token = TOKEN, origin = ORIGIN, answer = true } = {}) {
  const socket = new WebSocket(extensionUrl(relay, token), { origin })
  await waitForOpen(socket)
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.type !== 'rpc' || answer === false) return
    const result =
      message.method === 'targets'
        ? { targets: [{ targetId: 'target-1', tabId: 1, url: 'https://example.com/', title: 'Example', type: 'page', attached: false }] }
        : {}
    socket.send(JSON.stringify({ type: 'rpc-result', id: message.id, result }))
  })
  const welcome = waitForMessage(socket, (message) => message.type === 'welcome')
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, extensionId: 'abc', version: '0.7.0' }))
  return { socket, welcome: await welcome }
}

test('healthy pair: token, origin, hello/welcome, and a targets round-trip', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.close())
  assert.equal(relay.connected, false)

  const { socket, welcome } = await connectFakeExtension(relay)
  t.after(() => socket.terminate())
  assert.deepEqual(welcome, { type: 'welcome', protocol: 1, bridgeVersion: '0.8.1' })
  assert.equal(relay.connected, true)

  const result = await relay.call('targets')
  assert.deepEqual(result.targets, [
    { targetId: 'target-1', tabId: 1, url: 'https://example.com/', title: 'Example', type: 'page', attached: false },
  ])

  const received = new Promise((resolve) => relay.onEvent(resolve))
  socket.send(
    JSON.stringify({
      type: 'event',
      channel: 'debugger',
      payload: { tabId: 1, method: 'Page.loadEventFired', params: { timestamp: 7 } },
    }),
  )
  assert.deepEqual(await received, {
    channel: 'debugger',
    payload: { tabId: 1, method: 'Page.loadEventFired', params: { timestamp: 7 } },
  })
})

test('wrong token, absent origin, foreign origin and non-extension origin are closed with 1008', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.close())

  const wrongToken = new WebSocket(extensionUrl(relay, 'not-the-token'), { origin: ORIGIN })
  const absentOrigin = new WebSocket(extensionUrl(relay), {})
  const foreignOrigin = new WebSocket(extensionUrl(relay), { origin: 'chrome-extension://evil' })
  const webOrigin = new WebSocket(extensionUrl(relay), { origin: 'https://example.com' })
  const closed = await Promise.all([wrongToken, absentOrigin, foreignOrigin, webOrigin].map(waitForClose))
  for (const { code } of closed) assert.equal(code, 1008)
  assert.equal(relay.connected, false)
})

test('hello timeout and protocol mismatch close the socket', async (t) => {
  const relay = await startRelay({}, { helloTimeoutMs: 50 })
  t.after(() => relay.close())

  const silent = new WebSocket(extensionUrl(relay), { origin: ORIGIN })
  await waitForOpen(silent)
  const timedOut = await waitForClose(silent)
  assert.equal(timedOut.code, 1008)
  assert.match(timedOut.reason, /hello timeout/)

  const mismatched = new WebSocket(extensionUrl(relay), { origin: ORIGIN })
  await waitForOpen(mismatched)
  const closed = waitForClose(mismatched)
  mismatched.send(JSON.stringify({ type: 'hello', protocol: 2, extensionId: 'abc', version: '0.7.0' }))
  const mismatch = await closed
  assert.equal(mismatch.code, 1008)
  assert.match(mismatch.reason, /protocol mismatch/)
})

test('pending calls reject on extension disconnect and connected flips back after reconnect', async (t) => {
  const relay = await startRelay()
  t.after(() => relay.close())

  const { socket } = await connectFakeExtension(relay, { answer: false })
  assert.equal(relay.connected, true)

  const pending = relay.call('status')
  const settled = pending.then(
    () => null,
    (error) => error,
  )
  const closed = waitForClose(socket)
  socket.close()
  await closed
  const error = await settled
  assert.equal(error?.code, 'bridge_disconnected')
  assert.equal(relay.connected, false)

  const second = await connectFakeExtension(relay)
  t.after(() => second.socket.terminate())
  assert.equal(relay.connected, true)
})

test('upload path guard rejects escapes, outside files, missing files, and escaping symlinks', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bridge-upload-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'root')
  await mkdir(root)
  const inside = join(root, 'inside.txt')
  await writeFile(inside, 'inside')
  const outside = join(base, 'outside.txt')
  await writeFile(outside, 'outside')
  const link = join(root, 'link.txt')
  await symlink(outside, link)
  await mkdir(join(root, 'nested'))
  const nested = join(root, 'nested', 'file.txt')
  await writeFile(nested, 'nested')

  const denied = (path, code) =>
    assert.rejects(resolveUploadPaths([path], [root]), (error) => {
      assert.equal(error.code, code)
      return true
    })

  await denied(join(root, '..', 'outside.txt'), 'upload_path_denied')
  await denied(outside, 'upload_path_denied')
  await denied(join(root, 'missing.txt'), 'upload_path_missing')
  await denied(link, 'upload_path_denied')
  await denied(root, 'upload_path_denied')

  const accepted = await resolveUploadPaths([inside, nested], [root])
  assert.equal(accepted.length, 2)
  assert.equal(accepted[0], inside)
  assert.equal(accepted[1], nested)

  assert.equal(isWithinRoots(inside, [root]), true)
  assert.equal(isWithinRoots(root, [root]), true)
  assert.equal(isWithinRoots(`${root}-suffix/file.txt`, [root]), false)
  assert.equal(isWithinRoots(outside, [root]), false)
})

test('network ring buffer caps at the limit and body truncation sets truncated', () => {
  const log = createNetworkLog(3)
  for (let index = 0; index < 5; index += 1) {
    log.addRequest(7, {
      requestId: `request-${index}`,
      type: 'XHR',
      request: { url: `https://example.com/${index}`, method: 'GET' },
      wallTime: 1000 + index,
    })
  }
  assert.equal(log.size, 3)
  assert.equal(log.get('request-0'), undefined)
  assert.deepEqual(
    log.list().map((entry) => entry.requestId),
    ['request-2', 'request-3', 'request-4'],
  )
  log.addResponse(7, { requestId: 'request-3', type: 'XHR', response: { status: 200, mimeType: 'application/json' } })
  assert.equal(log.get('request-3').status, 200)
  log.addFinished(7, { requestId: 'request-3', encodedDataLength: 12 })
  assert.equal(log.pendingCount(7), 2)

  const bigBody = Buffer.alloc(NETWORK_BODY_LIMIT + 10, 0x61).toString('base64')
  const truncated = truncateBody(bigBody, true)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.size, NETWORK_BODY_LIMIT + 10)
  assert.equal(Buffer.from(truncated.base64, 'base64').byteLength, NETWORK_BODY_LIMIT)

  const small = truncateBody('hello', false)
  assert.equal(small.truncated, false)
  assert.equal(small.size, 5)
  assert.equal(Buffer.from(small.base64, 'base64').toString(), 'hello')

  log.clear()
  assert.equal(log.size, 0)
})

test('parseConfig applies defaults, environment overrides, and the disabled-tool list', () => {
  const defaults = parseConfig({}, { home: '/tmp/dsh-home', homedir: '/home/tester' })
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.port, 8790)
  assert.equal(defaults.token, BRIDGE_DEFAULT_TOKEN)
  assert.equal(defaults.home, '/tmp/dsh-home/browser-bridge')
  assert.deepEqual(defaults.extensionIds, [])
  assert.deepEqual(defaults.uploadRoots, ['/home/tester/Downloads', '/home/tester/Desktop'])
  assert.equal(defaults.downloadDir, '/home/tester/Downloads/dsh-browser')
  assert.deepEqual(defaults.disabledTools, [])
  assert.equal(defaults.networkLimit, 500)

  const overrides = parseConfig(
    {
      DSH_BROWSER_BRIDGE: '0',
      DSH_BROWSER_BRIDGE_PORT: '9001',
      DSH_BROWSER_BRIDGE_TOKEN: '  secret  ',
      DSH_BROWSER_BRIDGE_HOME: '/srv/bridge',
      DSH_BROWSER_BRIDGE_EXTENSION_ID: 'abc, def',
      DSH_BROWSER_BRIDGE_UPLOAD_ROOTS: '~/Downloads, /srv/files',
      DSH_BROWSER_BRIDGE_DOWNLOAD_DIR: '~/Downloads/custom',
      DSH_BROWSER_BRIDGE_DISABLE: 'evaluate, network,storage',
      DSH_BROWSER_BRIDGE_NETWORK_LIMIT: '25',
    },
    { homedir: '/home/tester' },
  )
  assert.equal(overrides.enabled, false)
  assert.equal(overrides.port, 9001)
  assert.equal(overrides.token, 'secret')
  assert.equal(overrides.home, '/srv/bridge')
  assert.deepEqual(overrides.extensionIds, ['abc', 'def'])
  assert.deepEqual(overrides.uploadRoots, ['/home/tester/Downloads', '/srv/files'])
  assert.equal(overrides.downloadDir, '/home/tester/Downloads/custom')
  assert.deepEqual(overrides.disabledTools, ['evaluate', 'network', 'storage'])
  assert.equal(overrides.networkLimit, 25)

  const dshHome = parseConfig({ DSH_HOME: '/opt/dsh-home' }, { homedir: '/home/tester' })
  assert.equal(dshHome.home, '/opt/dsh-home/browser-bridge')

  assert.throws(() => parseConfig({ DSH_BROWSER_BRIDGE_PORT: '99999' }), /DSH_BROWSER_BRIDGE_PORT/)
  assert.throws(() => parseConfig({ DSH_BROWSER_BRIDGE_NETWORK_LIMIT: '0' }), /DSH_BROWSER_BRIDGE_NETWORK_LIMIT/)
})

test('the derived feature state disables the bridge when browser control is off', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-features-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { DSH_HOME: home, DSH_BROWSER_BRIDGE_TOKEN: 'secret' }
  assert.deepEqual(await readFeatureState(env), {})
  const enabled = await loadConfig(env)
  assert.equal(enabled.enabled, true)

  await mkdir(join(home, 'dsh-dev-plugins'), { recursive: true })
  await writeFile(join(home, 'dsh-dev-plugins', 'features.json'), '{"browserControl":false}\n')
  const disabled = await loadConfig(env)
  assert.equal(disabled.enabled, false)
  assert.equal((await loadConfig({ ...env, DSH_BROWSER_BRIDGE: '0' })).enabled, false)
})

test('audit line shape drops typed text and records ok/ms/tool', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-audit-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  await auditToolCall(home, {
    tool: 'type',
    paramsSummary: summarizeParams('type', { ref: 'e1', text: 'hunter2-secret', clear: true }),
    tabId: 3,
    url: 'https://example.com/',
    ok: true,
    ms: 12,
  })
  const auditPath = join(home, 'audit.jsonl')
  const raw = await readFile(auditPath, 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.tool, 'type')
  assert.equal(record.ok, true)
  assert.equal(record.ms, 12)
  assert.equal(record.tabId, 3)
  assert.equal(record.url, 'https://example.com/')
  assert.deepEqual(record.paramsSummary.text, { length: 14 })
  assert.equal(typeof record.ts, 'string')
  assert.match(lines[0], /"ok":true/)
  assert.doesNotMatch(lines[0], /hunter2-secret/)
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600)
  assert.equal((await stat(home)).mode & 0o777, 0o700)

  const failure = buildAuditLine({ tool: 'click', paramsSummary: { ref: 'e9' }, ok: false, error: 'stale_ref', ms: 3 })
  assert.equal(failure.ok, false)
  assert.equal(failure.error, 'stale_ref')
  assert.equal(failure.tool, 'click')
})

test('the built-in token is used unless the environment overrides it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-token-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const builtIn = await loadConfig({ DSH_BROWSER_BRIDGE_HOME: home })
  assert.equal(builtIn.token, BRIDGE_DEFAULT_TOKEN)
  assert.equal(existsSync(join(home, 'token')), false, 'the bridge must not create a token file')

  const overridden = await loadConfig({ DSH_BROWSER_BRIDGE_TOKEN: 'deployment-secret' })
  assert.equal(overridden.token, 'deployment-secret')

  const blank = await loadConfig({ DSH_BROWSER_BRIDGE_TOKEN: '   ' })
  assert.equal(blank.token, BRIDGE_DEFAULT_TOKEN)
})

test('all 16 tools register with zod schemas and disabled tools are omitted', () => {
  const server = new McpServer({ name: 'browser-bridge-test', version: '0.0.0' })
  registerTools(server, {}, { home: join(tmpdir(), 'bridge-test-unused'), disabledTools: ['evaluate', 'network'] })

  const names = Object.keys(server._registeredTools).sort()
  assert.equal(names.length, 14)
  assert.equal(names.includes('evaluate'), false)
  assert.equal(names.includes('network'), false)
  assert.equal(names.includes('tabs'), true)
  assert.equal(names.includes('storage'), true)
  assert.equal(server._registeredTools.key.description.includes('keyboard'), true)
  const keySchema = server.toolInputSchemaJson('key')
  assert.deepEqual(Object.keys(keySchema.properties), ['keys'])
  const uploadSchema = server.toolInputSchemaJson('upload')
  assert.deepEqual(Object.keys(uploadSchema.properties).sort(), ['paths', 'ref', 'selector'])
})

test('formatKeyChord maps chords to CDP key fields and modifier masks', () => {
  assert.deepEqual(MODIFIER_MASKS, { Alt: 1, Control: 2, Meta: 4, Shift: 8 })

  const selectAll = formatKeyChord('Control+A')
  assert.equal(selectAll.modifiers, 2)
  assert.equal(selectAll.key, 'a')
  assert.equal(selectAll.code, 'KeyA')
  assert.equal(selectAll.windowsVirtualKeyCode, 65)
  assert.equal(selectAll.text, 'a')

  const shiftedEnter = formatKeyChord('Shift+Enter')
  assert.equal(shiftedEnter.modifiers, 8)
  assert.equal(shiftedEnter.key, 'Enter')
  assert.equal(shiftedEnter.code, 'Enter')
  assert.equal(shiftedEnter.windowsVirtualKeyCode, 13)
  assert.equal(shiftedEnter.text, '\r')

  const metaLeft = formatKeyChord('Meta+ArrowLeft')
  assert.equal(metaLeft.modifiers, 4)
  assert.equal(metaLeft.key, 'ArrowLeft')
  assert.equal(metaLeft.windowsVirtualKeyCode, 37)

  assert.equal(formatKeyChord('Escape').modifiers, 0)
  assert.equal(formatKeyChord('F5').windowsVirtualKeyCode, 116)
  assert.throws(() => formatKeyChord('Hyper+A'), /Unknown modifier/)
  assert.throws(() => formatKeyChord('NotAKey'), /Unknown key/)
})

test('network body tool waits for loadingFinished and retries while CDP reports no data', async (t) => {
  const entry = {
    requestId: 'req-1',
    tabId: 3,
    url: 'https://example.com/data.json',
    mimeType: 'application/json',
    finished: false,
  }
  const attempts = []
  const session = {
    activeTabId: 3,
    ensureActiveTab: async () => 3,
    urlFor: () => undefined,
    network: { get: (requestId) => (requestId === 'req-1' ? entry : undefined) },
    send: async (tabId, method, params) => {
      attempts.push({ tabId, method, params, finishedAtCall: entry.finished })
      if (attempts.length === 1) {
        const error = new Error('No data found for resource with given identifier')
        error.code = 'cdp_failed'
        throw error
      }
      return { body: '{"ok":true}', base64Encoded: false }
    },
  }

  const home = await mkdtemp(join(tmpdir(), 'bridge-network-audit-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const handlers = new Map()
  registerTools(
    { registerTool: (name, config, callback) => handlers.set(name, callback) },
    session,
    { home, disabledTools: [] },
  )

  const finishTimer = setTimeout(() => {
    entry.finished = true
  }, 20)
  const result = await handlers.get('network')({ op: 'body', requestId: 'req-1' })
  clearTimeout(finishTimer)

  assert.equal(result.isError, undefined)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].finishedAtCall, true)
  assert.equal(attempts[0].tabId, 3)
  assert.equal(attempts[0].method, 'Network.getResponseBody')
  assert.deepEqual(attempts[0].params, { requestId: 'req-1' })
  assert.deepEqual(JSON.parse(result.content[0].text), {
    requestId: 'req-1',
    url: 'https://example.com/data.json',
    mimeType: 'application/json',
    base64: Buffer.from('{"ok":true}').toString('base64'),
    size: 11,
    truncated: false,
  })
})

test('network body returns body_unavailable when the request never finishes', async () => {
  const entry = { requestId: 'slow-1', tabId: 1, url: '', mimeType: null, finished: false }
  let sends = 0
  const session = {
    network: { get: () => entry },
    send: async () => {
      sends += 1
      return {}
    },
  }
  await assert.rejects(readNetworkBody(session, 'slow-1', { waitTimeoutMs: 30, pollMs: 5 }), (error) => {
    assert.equal(error.code, 'body_unavailable')
    assert.match(error.message, /did not finish within 30 ms/)
    return true
  })
  assert.equal(sends, 0)
})

test('network body stops retrying after three no-data errors', async () => {
  const entry = { requestId: 'never-ready', tabId: 1, url: '', mimeType: null, finished: true }
  let sends = 0
  const session = {
    network: { get: () => entry },
    send: async () => {
      sends += 1
      const error = new Error('No data found for resource with given identifier')
      error.code = 'cdp_failed'
      throw error
    },
  }
  await assert.rejects(readNetworkBody(session, 'never-ready', { backoffMs: 5 }), (error) => {
    assert.equal(error.code, 'body_unavailable')
    assert.match(error.message, /No data found/)
    return true
  })
  assert.equal(sends, 3)
})

test('download url streams the file into the download directory and reports size', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello download')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address()

  const base = await mkdtemp(join(tmpdir(), 'bridge-download-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = join(base, 'nested', 'downloads')

  const saved = await saveDownload({ downloadDir: dir, url: `http://127.0.0.1:${port}/files/report.txt?token=abc` })
  assert.equal(saved.filename, 'report.txt')
  assert.equal(saved.path, join(dir, 'report.txt'))
  assert.equal(saved.size, Buffer.byteLength('hello download'))
  assert.equal(await readFile(saved.path, 'utf8'), 'hello download')
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600)

  const named = await saveDownload({
    downloadDir: dir,
    url: `http://127.0.0.1:${port}/ignored`,
    filename: 'chosen.bin',
  })
  assert.equal(named.filename, 'chosen.bin')
  assert.equal(named.size, Buffer.byteLength('hello download'))
  assert.equal(await readFile(join(dir, 'chosen.bin'), 'utf8'), 'hello download')
})

test('download rejects file URLs and path-escaping file names', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-download-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const httpUrl = 'http://127.0.0.1:1/file.txt'

  await assert.rejects(saveDownload({ downloadDir: dir, url: 'file:///etc/passwd' }), (error) => {
    assert.equal(error.code, 'invalid_params')
    assert.match(error.message, /http\(s\)/)
    return true
  })
  for (const filename of ['../escape.txt', '..', 'nested/file.txt', 'nested\\file.txt']) {
    await assert.rejects(saveDownload({ downloadDir: dir, url: httpUrl, filename }), (error) => {
      assert.equal(error.code, 'invalid_params')
      return true
    })
  }
  await assert.rejects(saveDownload({ downloadDir: dir, url: 'http://127.0.0.1:1/' }), (error) => {
    assert.equal(error.code, 'invalid_params')
    assert.match(error.message, /pass filename/)
    return true
  })
  await assert.rejects(saveDownload({ downloadDir: '', url: httpUrl }), (error) => {
    assert.equal(error.code, 'download_unavailable')
    return true
  })
  await assert.rejects(stat(join(dir, '..', 'escape.txt')))
})

test('download reports download_unavailable when the fetch fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-download-'))
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(() => resolve()))
  try {
    await assert.rejects(saveDownload({ downloadDir: dir, url: `http://127.0.0.1:${port}/gone.bin` }), (error) => {
      assert.equal(error.code, 'download_unavailable')
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('download url audits the saved path through the tool handler', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200)
    response.end('data')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address()

  const home = await mkdtemp(join(tmpdir(), 'bridge-download-audit-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const downloadDir = join(home, 'files')
  const handlers = new Map()
  registerTools(
    { registerTool: (name, config, callback) => handlers.set(name, callback) },
    {},
    { home, downloadDir, disabledTools: [] },
  )

  const result = await handlers.get('download')({ op: 'url', url: `http://127.0.0.1:${port}/saved.txt` })
  assert.equal(result.isError, undefined)
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.filename, 'saved.txt')
  assert.equal(payload.size, 4)
  assert.equal(payload.path, join(downloadDir, 'saved.txt'))
  assert.equal(await readFile(payload.path, 'utf8'), 'data')

  const record = JSON.parse((await readFile(join(home, 'audit.jsonl'), 'utf8')).trim())
  assert.equal(record.tool, 'download')
  assert.equal(record.ok, true)
  assert.deepEqual(record.paths, [payload.path])
})

test('download list maps the extension downloads payload', async () => {
  const calls = []
  const relay = {
    onEvent: () => () => {},
    call: async (method, params) => {
      calls.push([method, params])
      return {
        downloads: [
          {
            guid: 'guid-1',
            url: 'https://example.com/report.txt',
            filename: 'report.txt',
            path: '/tmp/report.txt',
            state: 'complete',
            bytesReceived: 12,
            totalBytes: 12,
            extra: 'ignored',
          },
        ],
      }
    },
  }
  const session = new ChromeSession(relay, {})
  const downloads = await session.listDownloads()
  session.close()
  assert.deepEqual(calls, [['downloads', { op: 'list' }]])
  assert.deepEqual(downloads, [
    {
      guid: 'guid-1',
      url: 'https://example.com/report.txt',
      filename: 'report.txt',
      path: '/tmp/report.txt',
      state: 'complete',
      bytesReceived: 12,
      totalBytes: 12,
    },
  ])
})

test('disabled download tool is not registered', () => {
  const server = new McpServer({ name: 'browser-bridge-test', version: '0.0.0' })
  registerTools(server, {}, { home: join(tmpdir(), 'bridge-test-unused'), disabledTools: ['download'] })
  const names = Object.keys(server._registeredTools)
  assert.equal(names.length, 15)
  assert.equal(names.includes('download'), false)
  assert.equal(names.includes('upload'), true)
  assert.equal(server.toolInputSchemaJson('download'), undefined)
})

test('selectAllChord uses Meta+A on macOS and Control+A elsewhere', () => {
  const mac = selectAllChord('darwin')
  assert.equal(mac.modifiers, MODIFIER_MASKS.Meta)
  assert.equal(mac.key, 'a')
  assert.equal(mac.code, 'KeyA')
  const linux = selectAllChord('linux')
  assert.equal(linux.modifiers, MODIFIER_MASKS.Control)
  const windows = selectAllChord('win32')
  assert.equal(windows.modifiers, MODIFIER_MASKS.Control)
})

test('type clear selects element contents before inserting text', async () => {
  const calls = []
  const session = fakeSession({
    send: async (tabId, method, params = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.querySelector':
          return { nodeId: 2 }
        case 'DOM.describeNode':
          return { node: { backendNodeId: 22 } }
        case 'DOM.resolveNode':
          return { object: { objectId: 'node-1' } }
        case 'Runtime.callFunctionOn':
          return { result: { value: params.functionDeclaration.includes('select()') } }
        default:
          return {}
      }
    },
  })
  const chords = []
  session.pressChord = async (_tabId, chord) => chords.push(chord)
  const handlers = toolHandlers(session)
  const result = await handlers.get('type')({ selector: '#name', text: 'x', clear: true })
  assert.equal(result.isError, undefined)

  const selectCall = calls.find(
    (call) => call.method === 'Runtime.callFunctionOn' && call.params.functionDeclaration.includes('select()'),
  )
  assert.equal(selectCall.params.objectId, 'node-1')
  assert.equal(selectCall.params.returnByValue, true)
  assert.deepEqual(
    calls.filter((call) => call.method === 'Input.insertText').map((call) => call.params),
    [{ text: 'x' }],
  )
  assert.equal(calls.some((call) => call.method === 'Input.dispatchKeyEvent'), false)
  assert.deepEqual(chords, [])
})

test('type clear falls back to the platform chord when select() is unavailable', async () => {
  const calls = []
  const session = fakeSession({
    send: async (tabId, method, params = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.querySelector':
          return { nodeId: 2 }
        case 'DOM.describeNode':
          return { node: { backendNodeId: 22 } }
        case 'DOM.resolveNode':
          return { object: { objectId: 'node-1' } }
        case 'Runtime.callFunctionOn':
          return { result: { value: false } }
        default:
          return {}
      }
    },
  })
  const chords = []
  session.pressChord = async (_tabId, chord) => chords.push(chord)
  const handlers = toolHandlers(session)
  const result = await handlers.get('type')({ selector: '#editor', text: 'y', clear: true })
  assert.equal(result.isError, undefined)
  assert.deepEqual(chords, [selectAllChord()])
  assert.deepEqual(
    calls.filter((call) => call.method === 'Input.insertText').map((call) => call.params),
    [{ text: 'y' }],
  )
})

test('screenshot translates the element clip into page coordinates', async () => {
  const calls = []
  const session = fakeSession({
    send: async (tabId, method, params = {}) => {
      calls.push({ method, params })
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.querySelector':
          return { nodeId: 2 }
        case 'DOM.describeNode':
          return { node: { backendNodeId: 22 } }
        case 'DOM.scrollIntoViewIfNeeded':
          return {}
        case 'DOM.getBoxModel':
          return { model: { content: [100, 200, 300, 200, 300, 260, 100, 260] } }
        case 'Page.getLayoutMetrics':
          return { cssVisualViewport: { pageX: 40, pageY: 500 }, cssLayoutViewport: { pageX: 0, pageY: 0 } }
        case 'Page.captureScreenshot':
          return { data: 'cG5n' }
        case 'Runtime.evaluate':
          return { result: { value: { url: 'https://example.com/', title: 'Example' } } }
        default:
          return {}
      }
    },
  })
  const handlers = toolHandlers(session)
  const result = await handlers.get('screenshot')({ selector: '#blue' })
  assert.equal(result.isError, undefined)

  const capture = calls.find((call) => call.method === 'Page.captureScreenshot')
  assert.deepEqual(capture.params.clip, { x: 140, y: 700, width: 200, height: 60, scale: 1 })
  assert.equal(capture.params.captureBeyondViewport, true)
  assert.equal(result.content[1].type, 'image')
  assert.equal(result.content[1].mimeType, 'image/png')
  assert.equal(result.content[1].data, 'cG5n')
})

test('navigate reports navigate_failed for Page.navigate errors and missing history entries', async () => {
  const handlers = toolHandlers(
    fakeSession({
      send: async (tabId, method) => (method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {}),
    }),
  )
  const failed = await handlers.get('navigate')({ url: 'https://nope.invalid/', waitUntil: 'none' })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /^navigate_failed: Navigation failed: net::ERR_NAME_NOT_RESOLVED/)

  const historyHandlers = toolHandlers(
    fakeSession({
      send: async (tabId, method) => (method === 'Page.getNavigationHistory' ? { currentIndex: 0, entries: [{ id: 3 }] } : {}),
    }),
  )
  const back = await historyHandlers.get('navigate')({ back: true, waitUntil: 'none' })
  assert.equal(back.isError, true)
  assert.match(back.content[0].text, /^navigate_failed: No navigation history entry to go back to/)
})

test('cookies clear by name requires a url and forwards it', async () => {
  const calls = []
  const handlers = toolHandlers(
    fakeSession({
      send: async (tabId, method, params = {}) => {
        calls.push({ method, params })
        return {}
      },
    }),
  )
  const failed = await handlers.get('cookies')({ op: 'clear', name: 'sid' })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /^invalid_params:/)
  assert.equal(calls.some((call) => call.method === 'Network.deleteCookies'), false)

  const scoped = []
  const withCurrentUrl = toolHandlers(
    fakeSession({
      urlFor: () => 'https://example.com/page',
      send: async (tabId, method, params = {}) => {
        scoped.push({ method, params })
        return {}
      },
    }),
  )
  const ok = await withCurrentUrl.get('cookies')({ op: 'clear', name: 'sid' })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(scoped, [{ method: 'Network.deleteCookies', params: { name: 'sid', url: 'https://example.com/page' } }])

  const explicit = []
  const withExplicitUrl = toolHandlers(
    fakeSession({
      send: async (tabId, method, params = {}) => {
        explicit.push({ method, params })
        return {}
      },
    }),
  )
  const okExplicit = await withExplicitUrl.get('cookies')({ op: 'clear', name: 'sid', urls: ['https://other.example/'] })
  assert.equal(okExplicit.isError, undefined)
  assert.deepEqual(explicit[0], {
    method: 'Network.deleteCookies',
    params: { name: 'sid', url: 'https://other.example/' },
  })
})

test('upload expands ~ against the user home and still enforces roots', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'bridge-home-')))
  const other = await realpath(await mkdtemp(join(tmpdir(), 'bridge-other-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  t.after(() => rm(other, { recursive: true, force: true }))
  const file = join(home, 'document.txt')
  await writeFile(file, 'doc')

  assert.deepEqual(await resolveUploadPaths(['~/document.txt'], [home], { home }), [file])
  await assert.rejects(resolveUploadPaths(['~root/document.txt'], [home], { home }), (error) => {
    assert.equal(error.code, 'invalid_params')
    return true
  })
  await assert.rejects(resolveUploadPaths(['~/document.txt'], [other], { home }), (error) => {
    assert.equal(error.code, 'upload_path_denied')
    return true
  })
  await assert.rejects(resolveUploadPaths(['~/missing.txt'], [home], { home }), (error) => {
    assert.equal(error.code, 'upload_path_missing')
    return true
  })
})

test('wait networkIdle restores the previous network recording state', async () => {
  const methods = []
  const relay = {
    onEvent: () => () => {},
    call: async (method, params = {}) => {
      methods.push(method === 'cdp' ? params.method : method)
      return {}
    },
  }
  const session = new ChromeSession(relay, {})

  assert.equal(await session.waitForFirst(1, { networkIdle: true }, 1000, 5), 'networkIdle')
  assert.deepEqual(
    methods.filter((method) => method === 'Network.enable' || method === 'Network.disable'),
    ['Network.enable', 'Network.disable'],
  )
  assert.equal(session.recording, false)

  methods.length = 0
  session.recording = true
  assert.equal(await session.waitForFirst(1, { networkIdle: true }, 1000, 5), 'networkIdle')
  assert.equal(methods.includes('Network.enable'), false)
  assert.equal(methods.includes('Network.disable'), false)
  assert.equal(session.recording, true)
  session.close()
})

test('download never truncates an existing file or follows a symlink', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200)
    response.end('fresh')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address()
  const base = await realpath(await mkdtemp(join(tmpdir(), 'bridge-download-safe-')))
  t.after(() => rm(base, { recursive: true, force: true }))

  const outDir = join(base, 'out')
  await mkdir(outDir)
  const existing = join(outDir, 'report.txt')
  await writeFile(existing, 'keep me')
  const saved = await saveDownload({ downloadDir: outDir, url: `http://127.0.0.1:${port}/report.txt` })
  assert.equal(saved.filename, 'report (1).txt')
  assert.equal(saved.path, join(outDir, 'report (1).txt'))
  assert.equal(await readFile(existing, 'utf8'), 'keep me')
  assert.equal(await readFile(saved.path, 'utf8'), 'fresh')

  const linkDir = join(base, 'links')
  await mkdir(linkDir)
  const outside = join(base, 'outside.txt')
  await writeFile(outside, 'outside')
  const linkPath = join(linkDir, 'report.txt')
  await symlink(outside, linkPath)
  const linked = await saveDownload({ downloadDir: linkDir, url: `http://127.0.0.1:${port}/report.txt` })
  assert.equal(linked.filename, 'report (1).txt')
  assert.equal(await readFile(outside, 'utf8'), 'outside')
  assert.equal(await readlink(linkPath), outside)
})

test('observe descriptors drop values for password inputs', () => {
  const cleaned = stripSecretValues([
    { ref: 'e1', tag: 'input', inputType: 'password', value: 'hunter2' },
    { ref: 'e2', tag: 'input', inputType: 'text', value: 'public' },
    { ref: 'e3', tag: 'textarea', value: 'note' },
  ])
  assert.deepEqual(cleaned, [
    { ref: 'e1', tag: 'input' },
    { ref: 'e2', tag: 'input', value: 'public' },
    { ref: 'e3', tag: 'textarea', value: 'note' },
  ])
})

test('evaluate rejects results larger than 1 MB', async () => {
  const big = 'x'.repeat(1024 * 1024 + 1)
  const handlers = toolHandlers(fakeSession({ send: async () => ({ result: { value: big } }) }))
  const result = await handlers.get('evaluate')({ expression: 'large()' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /^evaluate_too_large:/)

  const ok = await toolHandlers(fakeSession({ send: async () => ({ result: { value: 'small' } }) })).get('evaluate')({
    expression: 'small()',
  })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(JSON.parse(ok.content[0].text), { result: 'small' })
})
