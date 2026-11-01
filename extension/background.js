'use strict'

/**
 * dsh browser bridge: MV3 service worker.
 *
 * The extension is a thin relay between the local bridge (WebSocket client) and
 * `chrome.debugger` (CDP). All tool semantics and tab targeting live in the
 * bridge; this worker only forwards RPCs, results, and debugger events.
 *
 * The file is intentionally a classic (non-module) service worker with no
 * imports so `node --check` and the Node unit tests can load it as-is.
 */

/** Wire protocol version spoken by both halves. */
const PROTOCOL_VERSION = 1
/** Default bridge port on 127.0.0.1. */
const DEFAULT_PORT = 8790
/** Reconnect backoff bounds: 500 ms doubling up to 10 s. */
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10000
/** Fraction of the backoff delay added as jitter, split both ways. */
const RECONNECT_JITTER = 0.2
/** Keepalive ping cadence while the socket is open. */
const PING_INTERVAL_MS = 20000
/** The bridge must answer `hello` with `welcome` within this window. */
const HANDSHAKE_TIMEOUT_MS = 5000
/** Alarm that restarts the socket after the service worker is evicted. */
const KEEPALIVE_ALARM = 'keepalive'
const KEEPALIVE_PERIOD_MINUTES = 1
/** chrome.debugger protocol version; CDP itself is selected by the bridge. */
const DEBUGGER_PROTOCOL_VERSION = '1.3'
/** chrome.storage.local keys. */
const STORAGE_TOKEN = 'token'
const STORAGE_PORT = 'port'
/** WebSocket readyState values. */
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1
/** RPC error codes from docs/browser-control-protocol.md. */
const ERROR_CODES = Object.freeze({
  badRequest: 'bad_request',
  attachFailed: 'attach_failed',
  cdpFailed: 'cdp_failed',
  tabUnavailable: 'tab_unavailable',
  downloadFailed: 'download_failed',
})
/** CDP `Input.dispatchKeyEvent` modifier bitmask to flag names. */
const CHORD_MODIFIERS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 })
/** Channel name used for forwarded debugger events. */
const DEBUGGER_EVENT_CHANNEL = 'debugger'

/**
 * Live worker state. `attached` maps a tab id to the page metadata shown by the
 * popup; membership in that map is also the gate for forwarding debugger events.
 */
const state = {
  token: '',
  port: DEFAULT_PORT,
  connected: false,
  attached: new Map(),
  lastError: null,
}

/** The injected WebSocket constructor; tests replace it through the seam. */
let WebSocketImpl = typeof WebSocket === 'function' ? WebSocket : undefined
/** The current socket, when one exists. */
let socket = null
let reconnectTimer = null
let reconnectAttempt = 0
let handshakeTimer = null
let handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS
let heartbeatTimer = null
let pingCounter = 0
/** User pressed Disconnect: do not reconnect until Connect is pressed again. */
let manualDisconnect = false
/** Set once settings have been read from chrome.storage.local. */
let settingsLoaded = false

/** Send one text frame; tests swap this to capture outgoing frames. */
let frameSender = defaultFrameSender

/** Default sender: write the JSON text frame when the socket is open. */
function defaultFrameSender(text) {
  if (socket === null || socket.readyState !== SOCKET_OPEN) return false
  try {
    socket.send(text)
    return true
  } catch {
    return false
  }
}

/** Serialize and send one protocol frame. */
function sendFrame(frame) {
  try {
    return frameSender(JSON.stringify(frame)) !== false
  } catch {
    return false
  }
}

/** Clamp a port value to a usable TCP port, falling back to the default. */
function normalizePort(value) {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return DEFAULT_PORT
  return port
}

/**
 * Build the bridge WebSocket URL.
 * @param port - configured bridge port, invalid values fall back to 8790.
 * @param token - pairing token; percent-encoded as a query argument.
 * @returns the `ws://127.0.0.1:<port>/extension?token=<token>` URL.
 */
function parseServerUrl(port, token) {
  const safePort = normalizePort(port)
  const safeToken = typeof token === 'string' ? token : ''
  return `ws://127.0.0.1:${safePort}/extension?token=${encodeURIComponent(safeToken)}`
}

/**
 * Reconnect delay for one attempt.
 * @param attempt - zero-based failure count.
 * @param random - deterministic [0, 1) source for the ±20% jitter (tests pass 0.5).
 * @returns the delay in milliseconds, capped at 10 s.
 */
function backoffDelay(attempt, random = Math.random()) {
  const step = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** step)
  const unit = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5
  const delay = Math.round(base * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * unit))
  return Math.min(RECONNECT_MAX_MS, delay)
}

/**
 * Decode a CDP modifier bitmask into named flags.
 * @param modifiersMask - CDP `Input.dispatchKeyEvent` modifiers value.
 * @returns `{ alt, ctrl, meta, shift }` booleans.
 */
function parseChord(modifiersMask) {
  const mask = Number.isInteger(modifiersMask) ? modifiersMask : 0
  return {
    alt: (mask & CHORD_MODIFIERS.alt) !== 0,
    ctrl: (mask & CHORD_MODIFIERS.ctrl) !== 0,
    meta: (mask & CHORD_MODIFIERS.meta) !== 0,
    shift: (mask & CHORD_MODIFIERS.shift) !== 0,
  }
}

/** Human-readable message for an error or thrown value. */
function describeError(error) {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Map `chrome.debugger.getTargets()` output to the bridge target shape.
 * Only page targets can be attached through the bridge.
 * @param list - raw TargetInfo array.
 * @returns `{ targets: [{ targetId, tabId, url, title, type, attached }] }`
 */
function summarizeTargets(list) {
  if (!Array.isArray(list)) return []
  const targets = []
  for (const target of list) {
    if (target === null || typeof target !== 'object' || target.type !== 'page') continue
    targets.push({
      targetId: typeof target.id === 'string' ? target.id : '',
      tabId: Number.isInteger(target.tabId) ? target.tabId : null,
      url: typeof target.url === 'string' ? target.url : '',
      title: typeof target.title === 'string' ? target.title : '',
      type: 'page',
      attached: target.attached === true,
    })
  }
  return targets
}

/**
 * Map `chrome.downloads.search()` items to the bridge download shape.
 * @param list - raw DownloadItem array.
 * @returns `{ downloads: [{ guid, url, filename, path, state, bytesReceived, totalBytes }] }`
 */
function summarizeDownloads(list) {
  if (!Array.isArray(list)) return []
  const downloads = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const filename = typeof item.filename === 'string' ? item.filename : ''
    downloads.push({
      guid: String(item.id),
      url: typeof item.url === 'string' ? item.url : '',
      filename,
      path: filename,
      state: typeof item.state === 'string' ? item.state : '',
      bytesReceived: Number.isFinite(item.bytesReceived) ? item.bytesReceived : 0,
      totalBytes: Number.isFinite(item.totalBytes) ? item.totalBytes : 0,
    })
  }
  return downloads
}

/**
 * Fold one connection lifecycle event into a next state snapshot. Pure; the
 * worker copies the result over its live state.
 * @param current - previous state.
 * @param event - one of `{ type: 'connecting' | 'welcome' | 'closed' | 'error' | 'settings', ... }`.
 * @returns a new state object.
 */
function nextState(current, event) {
  const next = { ...current }
  const type = event !== null && typeof event === 'object' ? event.type : undefined
  if (type === 'connecting') {
    next.connected = false
    next.lastError = null
    return next
  }
  if (type === 'welcome') {
    next.connected = true
    next.lastError = null
    return next
  }
  if (type === 'closed') {
    next.connected = false
    if (typeof event.error === 'string' && event.error !== '') next.lastError = event.error
    return next
  }
  if (type === 'error') {
    next.lastError = typeof event.error === 'string' && event.error !== '' ? event.error : 'Unknown error'
    return next
  }
  if (type === 'settings') {
    if (typeof event.token === 'string') next.token = event.token
    if (event.port !== undefined) next.port = normalizePort(event.port)
    return next
  }
  return next
}

/** Replace the live state fields with the next connection snapshot. */
function updateState(event) {
  Object.assign(state, nextState(state, event))
}

/** Attached tab ids as the popup/status result shape. */
function attachedList() {
  const list = []
  for (const [tabId, tab] of state.attached) list.push({ tabId, url: tab.url, title: tab.title })
  return list
}

/** Snapshot of everything the popup and tests read. */
function getState() {
  return {
    token: state.token,
    port: state.port,
    connected: state.connected,
    attached: attachedList(),
    lastError: state.lastError,
  }
}

/** Record a successful attach; `info` is the page target metadata. */
function rememberAttached(tabId, info) {
  state.attached.set(tabId, { url: info?.url ?? '', title: info?.title ?? '' })
}

/** Drop a tab from the attached set; returns true when it was attached. */
function removeAttached(tabId) {
  return state.attached.delete(tabId)
}

/** Find the page target for one tab id, or undefined. Errors are swallowed. */
async function findPageTarget(chromeApi, tabId) {
  try {
    const targets = await chromeApi.debugger.getTargets()
    if (!Array.isArray(targets)) return undefined
    return targets.find((target) => target !== null && target.type === 'page' && target.tabId === tabId)
  } catch {
    return undefined
  }
}

/** Extract and validate the integer `tabId` RPC param. */
function readTabId(params) {
  const tabId = params !== null && typeof params === 'object' ? params.tabId : undefined
  return Number.isInteger(tabId) ? tabId : undefined
}

/** Build an `rpc-result` frame. */
function rpcResult(id, result) {
  return { type: 'rpc-result', id, result }
}

/** Build an `rpc-error` frame; `error` may be a thrown value or message string. */
function rpcError(id, code, error) {
  return { type: 'rpc-error', id, error: { code, message: describeError(error) } }
}

/** Forward one synthetic debugger event to the bridge. */
function sendDebuggerEvent(payload) {
  return sendFrame({ type: 'event', channel: DEBUGGER_EVENT_CHANNEL, payload })
}

/**
 * Execute one bridge RPC exactly once against the Chrome API.
 * @param message - the decoded `rpc` frame (`{ type, id, method, params }`).
 * @param chromeApi - the chrome API object to call (injectable for tests).
 * @param emit - receives synthetic `attached`/`detached` events; optional.
 * @returns the matching `rpc-result` or `rpc-error` frame, never throws.
 */
async function handleRpc(message, chromeApi = chrome, emit = () => {}) {
  const id = message !== null && typeof message === 'object' ? message.id : undefined
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
    return rpcError(id, ERROR_CODES.badRequest, 'rpc frame must carry a method')
  }
  const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
  const notify = (event) => {
    if (typeof emit !== 'function') return
    try {
      emit(event)
    } catch {
      /* an event sink failure must not break the RPC reply */
    }
  }

  try {
    if (message.method === 'targets') {
      let list
      try {
        list = await chromeApi.debugger.getTargets()
      } catch (error) {
        return rpcError(id, ERROR_CODES.badRequest, error)
      }
      return rpcResult(id, { targets: summarizeTargets(list) })
    }

    if (message.method === 'attach') {
      const tabId = readTabId(params)
      if (tabId === undefined) return rpcError(id, ERROR_CODES.badRequest, 'attach requires an integer tabId')
      if (state.attached.has(tabId)) return rpcResult(id, {})
      try {
        await chromeApi.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION)
      } catch (error) {
        return rpcError(id, ERROR_CODES.attachFailed, error)
      }
      const target = await findPageTarget(chromeApi, tabId)
      rememberAttached(tabId, target)
      notify({ tabId, method: 'attached', params: {} })
      return rpcResult(id, {})
    }

    if (message.method === 'detach') {
      const tabId = readTabId(params)
      if (tabId === undefined) return rpcError(id, ERROR_CODES.badRequest, 'detach requires an integer tabId')
      if (!state.attached.has(tabId)) return rpcResult(id, {})
      try {
        await chromeApi.debugger.detach({ tabId })
      } catch (error) {
        removeAttached(tabId)
        notify({ tabId, method: 'detached', params: { reason: 'detach_failed' } })
        return rpcError(id, ERROR_CODES.tabUnavailable, error)
      }
      removeAttached(tabId)
      notify({ tabId, method: 'detached', params: { reason: 'detach' } })
      return rpcResult(id, {})
    }

    if (message.method === 'activate') {
      const tabId = readTabId(params)
      if (tabId === undefined) return rpcError(id, ERROR_CODES.badRequest, 'activate requires an integer tabId')
      try {
        await chromeApi.tabs.update(tabId, { active: true })
      } catch (error) {
        return rpcError(id, ERROR_CODES.tabUnavailable, error)
      }
      return rpcResult(id, {})
    }

    if (message.method === 'create') {
      if (typeof params.url !== 'string' || params.url === '') {
        return rpcError(id, ERROR_CODES.badRequest, 'create requires a url')
      }
      let tab
      try {
        tab = await chromeApi.tabs.create({ url: params.url, active: true })
      } catch (error) {
        return rpcError(id, ERROR_CODES.tabUnavailable, error)
      }
      if (tab === null || typeof tab !== 'object' || !Number.isInteger(tab.id)) {
        return rpcError(id, ERROR_CODES.tabUnavailable, 'chrome.tabs.create returned no tab id')
      }
      const target = await findPageTarget(chromeApi, tab.id)
      return rpcResult(id, {
        tabId: tab.id,
        targetId: typeof target?.id === 'string' ? target.id : null,
      })
    }

    if (message.method === 'close') {
      const tabId = readTabId(params)
      if (tabId === undefined) return rpcError(id, ERROR_CODES.badRequest, 'close requires an integer tabId')
      try {
        await chromeApi.tabs.remove(tabId)
      } catch (error) {
        return rpcError(id, ERROR_CODES.tabUnavailable, error)
      }
      if (removeAttached(tabId)) notify({ tabId, method: 'detached', params: { reason: 'closed' } })
      return rpcResult(id, {})
    }

    if (message.method === 'cdp') {
      const tabId = readTabId(params)
      if (tabId === undefined) return rpcError(id, ERROR_CODES.badRequest, 'cdp requires an integer tabId')
      if (typeof params.method !== 'string' || params.method === '') {
        return rpcError(id, ERROR_CODES.badRequest, 'cdp requires a method')
      }
      if (!state.attached.has(tabId)) {
        return rpcError(id, ERROR_CODES.tabUnavailable, `tab ${tabId} is not attached`)
      }
      let result
      try {
        result = await chromeApi.debugger.sendCommand({ tabId }, params.method, params.params ?? {})
      } catch (error) {
        return rpcError(id, ERROR_CODES.cdpFailed, error)
      }
      return rpcResult(id, { result: result !== null && typeof result === 'object' ? result : {} })
    }

    if (message.method === 'downloads') {
      if (params.op !== 'list') {
        return rpcError(id, ERROR_CODES.badRequest, `unknown downloads op: ${String(params.op)}`)
      }
      let items
      try {
        items = await chromeApi.downloads.search({
          limit: Number.isInteger(params.limit) ? params.limit : 20,
          orderBy: ['-startTime'],
        })
      } catch (error) {
        return rpcError(id, ERROR_CODES.downloadFailed, error)
      }
      return rpcResult(id, { downloads: summarizeDownloads(items) })
    }

    if (message.method === 'status') {
      return rpcResult(id, { attached: attachedList() })
    }
  } catch (error) {
    return rpcError(id, ERROR_CODES.badRequest, error)
  }
  return rpcError(id, ERROR_CODES.badRequest, `unknown method: ${message.method}`)
}

/** Forward one `chrome.debugger.onEvent` callback, gated on the attached set. */
function handleDebuggerEvent(tabId, method, params) {
  if (!Number.isInteger(tabId) || typeof method !== 'string' || !state.attached.has(tabId)) return false
  return sendDebuggerEvent({
    tabId,
    method,
    params: params !== null && typeof params === 'object' ? params : {},
  })
}

/** Handle `chrome.debugger.onDetach`: drop the tab and tell the bridge. */
function handleDebuggerDetach(tabId, reason) {
  if (!Number.isInteger(tabId) || !removeAttached(tabId)) return false
  return sendDebuggerEvent({
    tabId,
    method: 'detached',
    params: { reason: typeof reason === 'string' ? reason : '' },
  })
}

/** Handle `chrome.tabs.onRemoved`: drop any stale attachment state. */
function handleTabRemoved(tabId) {
  if (!Number.isInteger(tabId) || !removeAttached(tabId)) return false
  return sendDebuggerEvent({ tabId, method: 'detached', params: { reason: 'tab_closed' } })
}

/** Clear the handshake watchdog. */
function stopHandshakeTimer() {
  if (handshakeTimer !== null) clearTimeout(handshakeTimer)
  handshakeTimer = null
}

/** Clear the 20 s keepalive ping. */
function stopHeartbeat() {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

/** Clear every connection timer. */
function stopTimers() {
  stopHandshakeTimer()
  stopHeartbeat()
  if (reconnectTimer !== null) clearTimeout(reconnectTimer)
  reconnectTimer = null
}

/** Detach handlers and close the current socket without scheduling a reconnect. */
function closeSocket() {
  const current = socket
  socket = null
  stopHandshakeTimer()
  stopHeartbeat()
  if (current === null) return
  try {
    current.onopen = null
    current.onmessage = null
    current.onclose = null
    current.onerror = null
    current.close()
  } catch {
    /* the socket may already be closed */
  }
}

/** Arm the watchdog that fails the handshake when `welcome` never arrives. */
function startHandshakeTimer(ws) {
  stopHandshakeTimer()
  handshakeTimer = setTimeout(() => {
    handshakeTimer = null
    if (socket !== ws || state.connected) return
    failConnection(`Bridge did not send welcome within ${handshakeTimeoutMs} ms`)
  }, handshakeTimeoutMs)
}

/** Start the keepalive ping loop for an open socket. */
function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    sendFrame({ type: 'ping', id: nextPingId() })
  }, PING_INTERVAL_MS)
}

/** Monotonic id for extension-initiated pings. */
function nextPingId() {
  pingCounter += 1
  return pingCounter
}

/** Read `{ token, port }` from chrome.storage.local into the live state. */
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_TOKEN, STORAGE_PORT])
    if (stored !== null && typeof stored === 'object') {
      if (typeof stored.token === 'string') state.token = stored.token
      if (stored.port !== undefined && stored.port !== null) state.port = normalizePort(stored.port)
    }
  } catch (error) {
    state.lastError = `Could not read the saved settings: ${describeError(error)}`
  }
  settingsLoaded = true
}

/** Persist `{ token, port }` to chrome.storage.local. */
async function saveSettings(token, port) {
  state.token = typeof token === 'string' ? token.trim() : ''
  state.port = normalizePort(port)
  await chrome.storage.local.set({ [STORAGE_TOKEN]: state.token, [STORAGE_PORT]: state.port })
  settingsLoaded = true
  return { token: state.token, port: state.port }
}

/** Create the keepalive alarm when the extension has not created it yet. */
function ensureKeepaliveAlarm() {
  try {
    chrome.alarms?.create?.(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES })
  } catch {
    /* the alarm API is optional in the test harness */
  }
}

/** Send `hello` and start the keepalive loop once the socket opens. */
function onSocketOpen(ws) {
  if (socket !== ws) return
  sendFrame({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
  })
  startHandshakeTimer(ws)
  startHeartbeat()
}

/** Accept `welcome` only when the bridge speaks the same protocol. */
function onWelcome(message) {
  if (message.protocol !== PROTOCOL_VERSION) {
    failConnection(`Bridge protocol ${String(message.protocol)} is not supported (expected ${PROTOCOL_VERSION})`)
    return false
  }
  stopHandshakeTimer()
  reconnectAttempt = 0
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  updateState({ type: 'welcome' })
  return true
}

/** Execute one `rpc` frame and send its exactly-once reply. */
async function dispatchRpc(message) {
  const reply = await handleRpc(message, chrome, (event) => sendDebuggerEvent(event))
  sendFrame(reply)
}

/** Decode one bridge frame and dispatch it. */
function onSocketMessage(ws, data) {
  if (socket !== ws) return
  if (typeof data !== 'string') {
    failConnection('Bridge sent a non-text frame')
    return
  }
  let message
  try {
    message = JSON.parse(data)
  } catch {
    failConnection('Bridge sent a malformed frame')
    return
  }
  if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
    failConnection('Bridge sent a malformed frame')
    return
  }
  if (message.type === 'welcome') {
    onWelcome(message)
    return
  }
  if (message.type === 'ping') {
    sendFrame({ type: 'pong', id: message.id })
    return
  }
  if (message.type === 'rpc') {
    void dispatchRpc(message)
  }
}

/** Record a connection failure, drop the socket, and schedule a retry. */
function failConnection(reason) {
  updateState({ type: 'closed', error: reason })
  closeSocket()
  scheduleReconnect()
}

/** Handle a socket close event; stale sockets are ignored. */
function onSocketClose(ws, event) {
  if (socket !== ws) return
  socket = null
  stopHandshakeTimer()
  stopHeartbeat()
  if (manualDisconnect) {
    updateState({ type: 'closed' })
    return
  }
  const reason =
    event !== null && typeof event === 'object' && typeof event.reason === 'string' && event.reason !== ''
      ? `: ${event.reason}`
      : ''
  updateState({ type: 'closed', error: `Bridge connection closed${reason}` })
  scheduleReconnect()
}

/** Schedule one reconnect with exponential backoff and jitter. */
function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer !== null || typeof WebSocketImpl !== 'function') return
  const delay = backoffDelay(reconnectAttempt)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void ensureConnected()
  }, delay)
}

/**
 * Open the bridge socket when settings are present and no socket is live.
 * @returns true when a connection attempt was started.
 */
function connect() {
  if (socket !== null && (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING)) return false
  manualDisconnect = false
  if (typeof WebSocketImpl !== 'function') {
    updateState({ type: 'error', error: 'This browser cannot open a WebSocket.' })
    return false
  }
  if (typeof state.token !== 'string' || state.token === '') {
    updateState({ type: 'error', error: 'Pairing token is missing. Save the token from the bridge first.' })
    return false
  }
  updateState({ type: 'connecting' })
  let ws
  try {
    ws = new WebSocketImpl(parseServerUrl(state.port, state.token))
  } catch (error) {
    failConnection(`Could not open the bridge socket: ${describeError(error)}`)
    return false
  }
  socket = ws
  ws.onopen = () => onSocketOpen(ws)
  ws.onmessage = (event) => onSocketMessage(ws, event?.data)
  ws.onclose = (event) => onSocketClose(ws, event)
  ws.onerror = () => {
    if (socket !== ws) return
    failConnection('Bridge connection failed')
  }
  return true
}

/** Load settings, then connect unless the user explicitly disconnected. */
async function ensureConnected() {
  await loadSettings()
  if (manualDisconnect) return false
  return connect()
}

/** User-initiated Disconnect: stay closed until Connect is pressed again. */
function disconnect() {
  manualDisconnect = true
  stopTimers()
  closeSocket()
  updateState({ type: 'closed' })
  return getState()
}

/** User-initiated Connect/Reconnect: reset backoff and open a fresh socket. */
async function reconnect() {
  manualDisconnect = false
  stopTimers()
  closeSocket()
  reconnectAttempt = 0
  return ensureConnected()
}

/** Popup `get-state`: settings and live connection state. */
async function popupGetState() {
  if (!settingsLoaded) await loadSettings()
  return { ok: true, state: getState() }
}

/** Popup `save-settings`: persist the pairing settings. */
async function popupSaveSettings(message) {
  const saved = await saveSettings(message.token, message.port)
  return { ok: true, saved, state: getState() }
}

/** Popup `reconnect`: Connect/Reconnect button. */
async function popupReconnect() {
  await reconnect()
  return { ok: true, state: getState() }
}

/** Popup `disconnect`: Disconnect button. */
function popupDisconnect() {
  disconnect()
  return { ok: true, state: getState() }
}

/** Popup message dispatch table. */
const POPUP_HANDLERS = {
  'get-state': popupGetState,
  'save-settings': popupSaveSettings,
  reconnect: popupReconnect,
  disconnect: popupDisconnect,
}

/**
 * `chrome.runtime.onMessage` listener for the popup.
 * @returns true when the response is delivered asynchronously.
 */
function handlePopupMessage(message, _sender, sendResponse) {
  if (message === null || typeof message !== 'object' || typeof message.type !== 'string') return false
  const handler = POPUP_HANDLERS[message.type]
  if (handler === undefined) {
    sendResponse({ ok: false, error: `unknown message: ${message.type}` })
    return false
  }
  Promise.resolve()
    .then(() => handler(message))
    .then(
      (result) => sendResponse(result),
      (error) => sendResponse({ ok: false, error: describeError(error) }),
    )
  return true
}

/** Register every chrome listener this worker needs. */
function installListeners() {
  chrome.runtime.onMessage?.addListener(handlePopupMessage)
  chrome.runtime.onStartup?.addListener(() => {
    manualDisconnect = false
    void ensureConnected()
  })
  chrome.runtime.onInstalled?.addListener(() => {
    void ensureConnected()
  })
  chrome.debugger.onEvent?.addListener((source, method, params) => {
    handleDebuggerEvent(source?.tabId, method, params)
  })
  chrome.debugger.onDetach?.addListener((source, reason) => {
    handleDebuggerDetach(source?.tabId, reason)
  })
  chrome.tabs.onRemoved?.addListener((tabId) => {
    handleTabRemoved(tabId)
  })
  chrome.alarms.onAlarm?.addListener((alarm) => {
    if (alarm?.name === KEEPALIVE_ALARM) void ensureConnected()
  })
  ensureKeepaliveAlarm()
}

/**
 * Test seam: pure helpers plus connection controls. The Node tests load this
 * file through `new Function('chrome', source)` and drive the worker with a
 * mock chrome API and a fake WebSocket.
 */
const testSeam = {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  ERROR_CODES,
  CHORD_MODIFIERS,
  parseServerUrl,
  backoffDelay,
  parseChord,
  summarizeTargets,
  summarizeDownloads,
  nextState,
  describeError,
  handleRpc,
  getState,
  handleDebuggerEvent,
  handleDebuggerDetach,
  handleTabRemoved,
  handlePopupMessage,
  connect,
  ensureConnected,
  reconnect,
  disconnect,
  loadSettings,
  saveSettings,
  getReconnectAttempt: () => reconnectAttempt,
  setWebSocketImpl(impl) {
    WebSocketImpl = impl
  },
  setSender(sender) {
    frameSender = typeof sender === 'function' ? sender : defaultFrameSender
  },
  setHandshakeTimeout(ms) {
    handshakeTimeoutMs = Number.isInteger(ms) && ms > 0 ? ms : HANDSHAKE_TIMEOUT_MS
  },
  resetState() {
    manualDisconnect = false
    stopTimers()
    closeSocket()
    reconnectAttempt = 0
    pingCounter = 0
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS
    frameSender = defaultFrameSender
    state.token = ''
    state.port = DEFAULT_PORT
    state.connected = false
    state.attached = new Map()
    state.lastError = null
    settingsLoaded = false
  },
}

globalThis.__dshBrowserBridgeTest = testSeam
if (typeof module !== 'undefined' && module !== null && typeof module.exports === 'object') {
  module.exports = testSeam
}

installListeners()

// A classic MV3 service worker exposes `importScripts`; when the file is loaded
// by the Node tests through the seam there is no worker and no socket is opened.
if (typeof importScripts === 'function') {
  void ensureConnected()
}
