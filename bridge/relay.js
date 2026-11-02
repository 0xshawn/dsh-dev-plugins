/**
 * WebSocket relay between the bridge and the Chrome extension.
 *
 * The extension is the only client allowed on `ws://127.0.0.1:<port>/extension`:
 * the query token is compared in constant time, the Origin must be
 * `chrome-extension://<id>` (and be allowlisted when configured), and a
 * `hello` frame with protocol 1 must arrive within five seconds. Requests use
 * correlated `rpc` ids; events are forwarded to subscribers; a disconnect
 * rejects every pending request.
 */
import { timingSafeEqual } from 'node:crypto'

import { WebSocketServer, WebSocket } from 'ws'

/** Wire-protocol version this bridge speaks. */
export const PROTOCOL_VERSION = 1
/** How long the extension has to say hello after the socket opens. */
export const HELLO_TIMEOUT_MS = 5000
/** Default per-RPC answer timeout. */
export const CALL_TIMEOUT_MS = 30000
/** App-level keepalive interval (the wire protocol has no native ping). */
const KEEPALIVE_MS = 30000

/** Error carrying a stable protocol code such as `bridge_disconnected`. */
export class BridgeError extends Error {
  /**
   * @param code - stable error code returned to tool callers.
   * @param message - operator-facing message.
   */
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * Compare two tokens without leaking their content through timing.
 * @param actual - token from the request.
 * @param expected - configured token.
 * @returns true when they are byte-identical.
 */
export function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual ?? ''), 'utf8')
  const right = Buffer.from(String(expected ?? ''), 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Extract the extension id from an Origin header.
 * @param origin - raw `Origin` header value.
 * @returns the id, or null when the origin is absent or not an extension origin.
 */
export function extensionIdFromOrigin(origin) {
  const prefix = 'chrome-extension://'
  if (typeof origin !== 'string' || !origin.startsWith(prefix)) return null
  const id = origin.slice(prefix.length).replace(/\/$/, '')
  return id === '' ? null : id
}

/**
 * Create the relay.
 * @param config - parsed bridge configuration.
 * @param options - timing overrides for tests.
 * @returns an unstarted {@link Relay}.
 */
export function createRelay(config, options = {}) {
  return new Relay(config, options)
}

/** The loopback WebSocket relay. */
export class Relay {
  /**
   * @param config - parsed bridge configuration.
   * @param options - `helloTimeoutMs`, `callTimeoutMs`, `keepaliveMs`,
   *   `bridgeVersion` overrides.
   */
  constructor(config, options = {}) {
    this.config = config
    this.token = config.token ?? ''
    this.extensionIds = Array.isArray(config.extensionIds) ? config.extensionIds : []
    this.port = config.port
    this.host = '127.0.0.1'
    this.bridgeVersion = options.bridgeVersion ?? '0.8.0'
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS

    this.server = null
    this.socket = null
    this.helloDone = false
    this.pending = new Map()
    this.nextId = 1
    this.listeners = new Set()
    this.helloTimer = null
    this.keepaliveTimer = null
  }

  /** Whether an extension is connected and has completed the handshake. */
  get connected() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN && this.helloDone
  }

  /**
   * Bind the loopback WebSocket server. Port 0 picks an ephemeral port, which
   * `this.port` then reports for tests and smoke checks.
   * @returns this relay once listening.
   */
  async listen() {
    this.server = new WebSocketServer({ host: this.host, port: this.port })
    await new Promise((resolve, reject) => {
      const onListening = () => {
        this.server.off('error', onError)
        resolve()
      }
      const onError = (error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      this.server.once('listening', onListening)
      this.server.once('error', onError)
    })
    this.port = this.server.address().port
    this.server.on('connection', (socket, request) => this.accept(socket, request))
    this.server.on('error', (error) => {
      console.error('browser-bridge: relay server error:', error instanceof Error ? error.message : error)
    })
    return this
  }

  /**
   * Register an event subscriber.
   * @param listener - receives `{ channel, payload }` extension event frames.
   * @returns an unsubscribe function.
   */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Send one RPC to the extension and await its answer.
   * @param method - extension method: targets, attach, detach, activate, create,
   *   close, cdp, or status.
   * @param params - method parameters.
   * @param options - `timeoutMs` override.
   * @returns the extension `result` payload.
   */
  call(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(bridgeDisconnected(`No Chrome extension is connected; open the extension popup and pair it with this bridge to call ${method}.`))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('timeout', `The extension did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        method,
        timer,
        resolve: (result) => {
          clearTimeout(timer)
          this.pending.delete(id)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        },
      })
      if (!this.send({ type: 'rpc', id, method, params })) {
        this.pending.get(id)?.reject(bridgeDisconnected(`The extension disconnected before ${method} was sent.`))
      }
    })
  }

  /** Close the relay, reject pending calls, and stop the server. */
  async close() {
    this.clearTimers()
    this.rejectPending(bridgeDisconnected('The bridge is shutting down.'))
    const socket = this.socket
    this.socket = null
    this.helloDone = false
    if (socket !== null) {
      try {
        socket.terminate()
      } catch {
        /* already gone */
      }
    }
    if (this.server !== null) {
      for (const client of this.server.clients) {
        try {
          client.terminate()
        } catch {
          /* already gone */
        }
      }
      const server = this.server
      this.server = null
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }

  /** Validate one upgraded connection and attach it as the extension. */
  accept(socket, request) {
    let url
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      return closeSocket(socket, 'invalid request')
    }
    if (url.pathname !== '/extension') return closeSocket(socket, 'unknown endpoint')
    if (!tokenMatches(url.searchParams.get('token') ?? '', this.token)) {
      return closeSocket(socket, 'invalid token')
    }
    const extensionId = extensionIdFromOrigin(request.headers.origin)
    if (extensionId === null) return closeSocket(socket, 'invalid origin')
    if (this.extensionIds.length > 0 && !this.extensionIds.includes(extensionId)) {
      return closeSocket(socket, 'extension not allowed')
    }

    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1008, 'replaced by a newer connection')
      } catch {
        /* already gone */
      }
    }
    this.clearTimers()
    this.socket = socket
    this.helloDone = false
    this.extensionId = extensionId

    socket.on('message', (data) => this.onMessage(socket, data))
    socket.on('close', () => {
      if (this.socket === socket) this.handleDisconnect()
    })
    socket.on('error', (error) => {
      console.error('browser-bridge: extension socket error:', error instanceof Error ? error.message : error)
    })

    this.helloTimer = setTimeout(() => {
      if (!this.helloDone) closeSocket(socket, 'hello timeout')
    }, this.helloTimeoutMs)
    this.helloTimer.unref?.()
  }

  onMessage(socket, data) {
    if (socket !== this.socket) return
    let message
    try {
      message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
    } catch {
      return closeSocket(socket, 'malformed frame')
    }
    if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
      return closeSocket(socket, 'malformed frame')
    }

    if (!this.helloDone) {
      if (message.type !== 'hello') return closeSocket(socket, 'hello required')
      if (message.protocol !== PROTOCOL_VERSION) return closeSocket(socket, 'protocol mismatch')
      clearTimeout(this.helloTimer)
      this.helloTimer = null
      this.helloDone = true
      this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, bridgeVersion: this.bridgeVersion })
      this.startKeepalive()
      return
    }

    switch (message.type) {
      case 'rpc-result': {
        const entry = this.pending.get(message.id)
        entry?.resolve(message.result ?? {})
        return
      }
      case 'rpc-error': {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        const code = typeof message.error?.code === 'string' ? message.error.code : 'extension_error'
        const text = typeof message.error?.message === 'string' ? message.error.message : 'extension call failed'
        entry.reject(new BridgeError(code, text))
        return
      }
      case 'event': {
        for (const listener of this.listeners) {
          try {
            listener({ channel: message.channel, payload: message.payload })
          } catch (error) {
            console.error('browser-bridge: event listener failed:', error instanceof Error ? error.message : error)
          }
        }
        return
      }
      case 'pong':
        return
      case 'ping':
        // The protocol has the bridge initiate keepalives, but tolerate an
        // extension-initiated ping by echoing its id as a pong.
        this.send({ type: 'pong', id: message.id })
        return
      default:
        return closeSocket(socket, 'unknown frame type')
    }
  }

  send(frame) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  startKeepalive() {
    this.clearKeepalive()
    this.keepaliveTimer = setInterval(() => {
      if (this.connected) this.send({ type: 'ping', id: this.nextId++ })
    }, this.keepaliveMs)
    this.keepaliveTimer.unref?.()
  }

  clearKeepalive() {
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  clearTimers() {
    if (this.helloTimer !== null) clearTimeout(this.helloTimer)
    this.helloTimer = null
    this.clearKeepalive()
  }

  handleDisconnect() {
    this.socket = null
    this.helloDone = false
    this.extensionId = undefined
    this.clearTimers()
    this.rejectPending(bridgeDisconnected('The extension disconnected before answering.'))
  }

  rejectPending(error) {
    for (const entry of [...this.pending.values()]) entry.reject(new BridgeError(error.code, `${entry.method}: ${error.message}`))
    this.pending.clear()
  }
}

function bridgeDisconnected(message) {
  return new BridgeError('bridge_disconnected', message)
}

function closeSocket(socket, reason) {
  try {
    socket.close(1008, reason)
  } catch {
    /* already closed */
  }
}
