/**
 * Network recording for the `network` tool: an in-memory ring buffer of
 * request metadata plus bounded response-body truncation. Nothing is written
 * to disk.
 */
import { BridgeError } from './relay.js'

/** Upper bound for one response body reported by the `network` tool. */
export const NETWORK_BODY_LIMIT = 2 * 1024 * 1024

/**
 * Ring buffer of network requests recorded from `Network.*` events.
 * @param limit - maximum number of tracked requests.
 */
export function createNetworkLog(limit = 500) {
  const entries = []
  const byId = new Map()

  const trim = () => {
    while (entries.length > limit) {
      const removed = entries.shift()
      if (removed !== undefined && byId.get(removed.requestId) === removed) byId.delete(removed.requestId)
    }
  }

  return {
    addRequest(tabId, params = {}) {
      if (typeof params.requestId !== 'string' || limit <= 0) return
      const existing = byId.get(params.requestId)
      if (existing !== undefined) {
        existing.url = params.request?.url ?? existing.url
        existing.method = params.request?.method ?? existing.method
        existing.tabId = tabId
        return
      }
      const entry = {
        requestId: params.requestId,
        tabId,
        url: params.request?.url ?? '',
        method: params.request?.method ?? '',
        type: params.type ?? null,
        startedAt: params.wallTime ?? Date.now(),
        status: null,
        mimeType: null,
        finished: false,
        failed: false,
        encodedDataLength: 0,
      }
      entries.push(entry)
      byId.set(entry.requestId, entry)
      trim()
    },
    addResponse(tabId, params = {}) {
      const entry = byId.get(params.requestId)
      if (entry === undefined) return
      entry.status = params.response?.status ?? null
      entry.mimeType = params.response?.mimeType ?? null
      entry.type = params.type ?? entry.type
    },
    addFinished(tabId, params = {}) {
      const entry = byId.get(params.requestId)
      if (entry === undefined) return
      entry.finished = true
      if (Number.isFinite(params.encodedDataLength)) entry.encodedDataLength = params.encodedDataLength
    },
    addFailed(tabId, params = {}) {
      const entry = byId.get(params.requestId)
      if (entry === undefined) return
      entry.finished = true
      entry.failed = true
    },
    list() {
      return entries.map((entry) => ({ ...entry }))
    },
    get(requestId) {
      return byId.get(requestId)
    },
    pendingCount(tabId) {
      return entries.filter((entry) => entry.tabId === tabId && !entry.finished).length
    },
    clear() {
      entries.length = 0
      byId.clear()
    },
    get size() {
      return entries.length
    },
  }
}

/**
 * Normalize a CDP response body into the tool payload and truncate it at the
 * network body limit.
 * @param body - raw body string.
 * @param base64Encoded - whether CDP returned base64.
 * @param maxBytes - byte cap.
 * @returns `{ base64, size, truncated }`.
 */
export function truncateBody(body, base64Encoded, maxBytes = NETWORK_BODY_LIMIT) {
  const source = typeof body === 'string' ? body : ''
  const buffer = base64Encoded ? Buffer.from(source, 'base64') : Buffer.from(source, 'utf8')
  const size = buffer.byteLength
  const truncated = size > maxBytes
  return {
    base64: (truncated ? buffer.subarray(0, maxBytes) : buffer).toString('base64'),
    size,
    truncated,
  }
}

/** How long `network body` waits for a request to finish before giving up. */
export const NETWORK_BODY_WAIT_MS = 5000
/** Body retry attempts while CDP still reports "No data found". */
export const NETWORK_BODY_ATTEMPTS = 3
/** Delay between body retries, matching the CDP body cache settling window. */
export const NETWORK_BODY_BACKOFF_MS = 250
/** Poll interval while waiting for `Network.loadingFinished`. */
const NETWORK_BODY_POLL_MS = 100

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toolError(code, message) {
  return new BridgeError(code, message)
}

/**
 * Wait until a tracked request reports `finished`, so `Network.getResponseBody`
 * is called after `Network.loadingFinished` instead of racing it.
 * @param entry - ring-buffer entry with a mutable `finished` flag.
 * @param options - `timeoutMs` and `pollMs` overrides (`waitTimeoutMs` when called from `readNetworkBody`).
 */
export async function waitForNetworkFinish(entry, { timeoutMs, pollMs = NETWORK_BODY_POLL_MS } = {}) {
  const limitMs = timeoutMs ?? NETWORK_BODY_WAIT_MS
  const deadline = Date.now() + limitMs
  while (entry.finished !== true) {
    if (Date.now() >= deadline) {
      throw toolError(
        'body_unavailable',
        `The response body is not available yet: request ${entry.requestId} did not finish within ${limitMs} ms`,
      )
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Read one response body from the tracked request.
 *
 * The request may still be loading (wait for the finish event), and CDP can
 * briefly answer `No data found for resource with given identifier` after the
 * finish event; retry that specific error a few times before failing.
 * @param session - Chrome session (`network` log and `send`).
 * @param requestId - tracked request id.
 * @param options - timing overrides for tests.
 * @returns `{ requestId, url, mimeType, base64, size, truncated }`.
 */
export async function readNetworkBody(session, requestId, options = {}) {
  const entry = session.network.get(requestId)
  if (entry === undefined) throw toolError('request_not_found', `No tracked request ${requestId}`)
  if (entry.finished !== true) await waitForNetworkFinish(entry, { timeoutMs: options.waitTimeoutMs, pollMs: options.pollMs })

  const attempts = options.attempts ?? NETWORK_BODY_ATTEMPTS
  const backoffMs = options.backoffMs ?? NETWORK_BODY_BACKOFF_MS
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const body = await session.send(entry.tabId, 'Network.getResponseBody', { requestId })
      const truncated = truncateBody(body?.body ?? '', body?.base64Encoded === true)
      return {
        requestId,
        url: entry.url,
        mimeType: entry.mimeType,
        base64: truncated.base64,
        size: truncated.size,
        truncated: truncated.truncated,
      }
    } catch (error) {
      if (['bridge_disconnected', 'tab_unavailable', 'attach_failed'].includes(error?.code)) throw error
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (!/No data found/i.test(message)) break
      if (attempt < attempts) await delay(backoffMs)
    }
  }
  throw toolError(
    'body_unavailable',
    `Could not read the response body: ${lastError instanceof Error ? lastError.message : lastError}`,
  )
}
