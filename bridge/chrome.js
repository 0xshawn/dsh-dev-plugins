/**
 * High-level CDP session layer over the WebSocket relay.
 *
 * The extension is a dumb relay: it forwards `chrome.debugger` commands. This
 * module owns tab targeting (attach on demand), the per-tab ref map, event
 * invalidation, the network ring buffer, download history, and the wait
 * helpers. DOM helpers live in `dom.js`.
 */
import { asBridgeError, browserError } from './errors.js'
import { createNetworkLog } from './network.js'
import { createRefStore } from './refs.js'

/** Target-list cache lifetime; sweeps still refresh explicitly. */
const TARGET_CACHE_MS = 2000
/** Poll interval for the wait helpers. */
const POLL_MS = 100

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One CDP session over the relay. */
export class ChromeSession {
  /**
   * @param relay - connected {@link import('./relay.js').Relay}.
   * @param config - parsed bridge configuration (`networkLimit`).
   */
  constructor(relay, config = {}) {
    this.relay = relay
    this.network = createNetworkLog(config.networkLimit ?? 500)
    this.recording = false
    this.refs = new Map()
    this.attached = new Set()
    this.activeTabId = null
    this.targetsCache = null
    this.targetsAt = 0
    this.dialogs = new Map()
    this.knownUrls = new Map()
    this.unsubscribe = relay.onEvent((event) => this.handleEvent(event))
  }

  /** Detach the event subscription; pending RPCs belong to the relay. */
  close() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /**
   * List `type: "page"` targets, cached briefly so tool calls do not each pay
   * an RPC.
   * @param options - `fresh` bypasses the cache.
   */
  async listTargets({ fresh = false } = {}) {
    const now = Date.now()
    if (!fresh && this.targetsCache !== null && now - this.targetsAt < TARGET_CACHE_MS) return this.targetsCache
    let result
    try {
      result = await this.relay.call('targets')
    } catch (error) {
      throw asBridgeError(error)
    }
    const targets = Array.isArray(result?.targets)
      ? result.targets.filter((target) => target?.type === 'page' && Number.isInteger(target?.tabId))
      : []
    this.targetsCache = targets
    this.targetsAt = now
    for (const target of targets) {
      if (typeof target.url === 'string' && target.url !== '') this.knownUrls.set(target.tabId, target.url)
    }
    if (this.activeTabId !== null && !targets.some((target) => target.tabId === this.activeTabId)) {
      this.activeTabId = null
    }
    if (this.activeTabId === null && targets.length > 0) this.activeTabId = targets[0].tabId
    return targets
  }

  invalidateTargets() {
    this.targetsCache = null
    this.targetsAt = 0
  }

  /** The active tab target, defaulting to the first page target. */
  async activeTab() {
    const targets = await this.listTargets()
    const target = targets.find((entry) => entry.tabId === this.activeTabId)
    if (target === undefined) {
      throw browserError('tab_unavailable', 'No page tab is available; open a tab in Chrome and call tabs list.')
    }
    return target
  }

  /** The active tab id. */
  async ensureActiveTab() {
    return (await this.activeTab()).tabId
  }

  /**
   * Attach the debugger to a tab on first use and enable the domains the tools
   * need. The extension method is a no-op when the tab is already attached.
   * @param tabId - Chrome tab id.
   */
  async attach(tabId) {
    if (!Number.isInteger(tabId)) throw browserError('invalid_params', 'tabId must be an integer')
    if (this.attached.has(tabId)) return
    try {
      await this.relay.call('attach', { tabId })
    } catch (error) {
      const wrapped = asBridgeError(error, 'attach_failed')
      if (['tab_unavailable', 'detached', 'target_closed', 'no_tab'].includes(wrapped.code)) {
        this.dropTab(tabId)
        throw browserError('tab_unavailable', `Tab ${tabId} is no longer available: ${wrapped.message}`)
      }
      throw browserError('attach_failed', `Could not attach the debugger to tab ${tabId}: ${wrapped.message}`)
    }
    this.attached.add(tabId)
    for (const method of ['Page.enable', 'DOM.enable']) {
      try {
        await this.rawSend(tabId, method, {})
      } catch (error) {
        console.error(`browser-bridge: ${method} failed on tab ${tabId}:`, error instanceof Error ? error.message : error)
      }
    }
  }

  /**
   * Send one CDP command after attaching the tab.
   * @param tabId - Chrome tab id.
   * @param method - CDP method.
   * @param params - CDP parameters.
   * @returns the CDP result object.
   */
  async send(tabId, method, params = {}) {
    await this.attach(tabId)
    return this.rawSend(tabId, method, params)
  }

  async rawSend(tabId, method, params = {}) {
    let result
    try {
      result = await this.relay.call('cdp', { tabId, method, params })
    } catch (error) {
      const wrapped = asBridgeError(error)
      if (['tab_unavailable', 'detached', 'target_closed', 'no_tab'].includes(wrapped.code)) {
        this.dropTab(tabId)
        throw browserError('tab_unavailable', `Tab ${tabId} is no longer available: ${wrapped.message}`)
      }
      throw wrapped
    }
    return result?.result ?? {}
  }

  /**
   * Detach and forget everything cached for a tab.
   * @param tabId - Chrome tab id.
   */
  async detach(tabId) {
    if (this.attached.has(tabId)) {
      try {
        await this.relay.call('detach', { tabId })
      } catch {
        /* the extension may have lost the tab already */
      }
    }
    this.dropTab(tabId)
  }

  dropTab(tabId) {
    this.attached.delete(tabId)
    this.refs.delete(tabId)
    this.dialogs.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = null
    this.invalidateTargets()
  }

  /** Invalidate the refs of one tab. */
  invalidateRefs(tabId) {
    this.refs.get(tabId)?.clear()
  }

  /** Invalidate every tab's refs (tab switch). */
  invalidateAllRefs() {
    for (const store of this.refs.values()) store.clear()
  }

  /** The ref store of a tab, created lazily. */
  refStore(tabId) {
    let store = this.refs.get(tabId)
    if (store === undefined) {
      store = createRefStore()
      this.refs.set(tabId, store)
    }
    return store
  }

  /**
   * Resolve an `observe` ref for a tab.
   * @returns `{ backendNodeId, frameId, snapshotAt }`; unknown refs throw `stale_ref`.
   */
  resolveRef(tabId, ref) {
    const entry = this.refs.get(tabId)?.get(ref)
    if (entry === undefined) {
      throw browserError('stale_ref', `Ref ${ref} is not valid for tab ${tabId}; call observe again to refresh refs.`)
    }
    return entry
  }

  /** Remember the last URL seen for a tab (audit + payloads). */
  rememberUrl(tabId, url) {
    if (typeof url === 'string' && url !== '') this.knownUrls.set(tabId, url)
  }

  urlFor(tabId) {
    return this.knownUrls.get(tabId)
  }

  handleEvent(event) {
    if (event?.channel !== 'debugger') return
    const payload = event.payload ?? {}
    const tabId = payload.tabId
    if (!Number.isInteger(tabId)) return
    const params = payload.params ?? {}
    switch (payload.method) {
      case 'attached':
        return
      case 'detached':
        this.dropTab(tabId)
        return
      case 'Page.frameNavigated':
        if (params.frame?.parentId === undefined) {
          this.invalidateRefs(tabId)
          this.rememberUrl(tabId, params.frame?.url)
          this.invalidateTargets()
        }
        return
      case 'Page.javascriptDialogOpening':
        this.dialogs.set(tabId, params)
        return
      case 'Page.javascriptDialogClosed':
        this.dialogs.delete(tabId)
        return
      case 'Network.requestWillBeSent':
        if (this.recording) this.network.addRequest(tabId, params)
        return
      case 'Network.responseReceived':
        if (this.recording) this.network.addResponse(tabId, params)
        return
      case 'Network.loadingFinished':
        if (this.recording) this.network.addFinished(tabId, params)
        return
      case 'Network.loadingFailed':
        if (this.recording) this.network.addFailed(tabId, params)
        return
      default:
        return
    }
  }

  /**
   * Download history from the extension (`chrome.downloads.search`), mapped to
   * the tool's stable shape.
   * @returns `{ guid, url, filename, path, state, bytesReceived, totalBytes }[]`.
   */
  async listDownloads() {
    let result
    try {
      result = await this.relay.call('downloads', { op: 'list' })
    } catch (error) {
      throw asBridgeError(error)
    }
    const entries = Array.isArray(result?.downloads) ? result.downloads : []
    return entries.map((entry) => ({
      guid: typeof entry?.guid === 'string' ? entry.guid : '',
      url: typeof entry?.url === 'string' ? entry.url : '',
      filename: typeof entry?.filename === 'string' ? entry.filename : '',
      path: typeof entry?.path === 'string' && entry.path !== '' ? entry.path : null,
      state: typeof entry?.state === 'string' ? entry.state : '',
      bytesReceived: Number.isFinite(entry?.bytesReceived) ? entry.bytesReceived : 0,
      totalBytes: Number.isFinite(entry?.totalBytes) ? entry.totalBytes : 0,
    }))
  }

  /** Dispatch one formatted chord via `Input.dispatchKeyEvent`. */
  async pressChord(tabId, chord) {
    const base = {
      modifiers: chord.modifiers ?? 0,
      key: chord.key,
      code: chord.code,
      windowsVirtualKeyCode: chord.windowsVirtualKeyCode,
      nativeVirtualKeyCode: chord.windowsVirtualKeyCode,
    }
    const typesText = typeof chord.text === 'string' && (chord.modifiers === 0 || chord.text === '\r')
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: typesText ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(typesText ? { text: chord.text } : {}),
    })
    await this.send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Enable `Network` and start recording requests for `network start`. */
  async startNetwork(tabId) {
    await this.attach(tabId)
    await this.send(tabId, 'Network.enable', {})
    this.recording = true
  }

  /** Stop recording (the buffered requests stay readable). */
  async stopNetwork(tabId) {
    this.recording = false
    try {
      await this.send(tabId, 'Network.disable', {})
    } catch {
      /* the tab may be gone; the buffer is still valid */
    }
  }

  /** Wait until `document.readyState` reaches the requested phase. */
  async waitForLoad(tabId, waitUntil = 'load', timeoutMs = 15000) {
    if (waitUntil === 'none') return
    const wanted = waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete']
    await this.waitForCondition(
      async () => {
        const response = await this.send(tabId, 'Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        return wanted.includes(response?.result?.value)
      },
      timeoutMs,
      `Page did not reach ${waitUntil} within ${timeoutMs} ms`,
    )
  }

  /** Wait until a selector matches at least one element. */
  async waitForSelector(tabId, selector, timeoutMs = 15000) {
    await this.waitForCondition(
      async () => {
        const response = await this.send(tabId, 'Runtime.evaluate', {
          expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
          returnByValue: true,
        })
        return response?.result?.value === true
      },
      timeoutMs,
      `No element matched ${selector} within ${timeoutMs} ms`,
    )
  }

  /** Wait until the page text contains a string. */
  async waitForText(tabId, text, timeoutMs = 15000) {
    await this.waitForCondition(
      async () => {
        const response = await this.send(tabId, 'Runtime.evaluate', {
          expression: `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`,
          returnByValue: true,
        })
        return response?.result?.value === true
      },
      timeoutMs,
      `The page text did not contain ${JSON.stringify(text)} within ${timeoutMs} ms`,
    )
  }

  /** Wait until no network request of the tab is in flight for `idleMs`. */
  async waitForNetworkIdle(tabId, timeoutMs = 15000, idleMs = 500) {
    await this.startNetwork(tabId)
    let idleSince = null
    await this.waitForCondition(
      async () => {
        if (this.network.pendingCount(tabId) > 0) {
          idleSince = null
          return false
        }
        if (idleSince === null) idleSince = Date.now()
        return Date.now() - idleSince >= idleMs
      },
      timeoutMs,
      `The network did not go idle within ${timeoutMs} ms`,
    )
  }

  /**
   * Wait for whichever of selector / text / network-idle becomes true first.
   * @param conditions - `{ selector?, text?, networkIdle? }`.
   * @returns the matched condition name.
   */
  async waitForFirst(tabId, { selector, text, networkIdle } = {}, timeoutMs = 15000, idleMs = 500) {
    // `networkIdle` needs Network.enable, but only for the duration of the
    // wait: restore the caller's recording state afterwards.
    const managesRecording = networkIdle === true && this.recording !== true
    if (managesRecording) await this.startNetwork(tabId)
    try {
      let idleSince = null
      let matched
      await this.waitForCondition(
        async () => {
          if (selector !== undefined) {
            const response = await this.send(tabId, 'Runtime.evaluate', {
              expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
              returnByValue: true,
            })
            if (response?.result?.value === true) {
              matched = 'selector'
              return true
            }
          }
          if (text !== undefined) {
            const response = await this.send(tabId, 'Runtime.evaluate', {
              expression: `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`,
              returnByValue: true,
            })
            if (response?.result?.value === true) {
              matched = 'text'
              return true
            }
          }
          if (networkIdle === true) {
            if (this.network.pendingCount(tabId) > 0) {
              idleSince = null
            } else {
              if (idleSince === null) idleSince = Date.now()
              if (Date.now() - idleSince >= idleMs) {
                matched = 'networkIdle'
                return true
              }
            }
          }
          return false
        },
        timeoutMs,
        `No wait condition was met within ${timeoutMs} ms`,
      )
      return matched
    } finally {
      if (managesRecording) await this.stopNetwork(tabId)
    }
  }

  async waitForCondition(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await predicate()) return
      if (Date.now() >= deadline) throw browserError('timeout', message)
      await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
    }
  }

  /** Current dialog parameters for a tab, if one is open. */
  pendingDialog(tabId) {
    return this.dialogs.get(tabId)
  }

  clearDialog(tabId) {
    this.dialogs.delete(tabId)
  }

  /** Open a new active tab. */
  async createTab(url = 'about:blank') {
    let result
    try {
      result = await this.relay.call('create', { url })
    } catch (error) {
      throw asBridgeError(error, 'create_failed')
    }
    if (!Number.isInteger(result?.tabId)) throw browserError('create_failed', 'The extension did not return a tab id')
    this.invalidateTargets()
    this.invalidateAllRefs()
    this.activeTabId = result.tabId
    this.rememberUrl(result.tabId, url)
    return result
  }

  /** Activate (focus) a tab and make it the session's active tab. */
  async activateTab(tabId) {
    try {
      await this.relay.call('activate', { tabId })
    } catch (error) {
      throw asBridgeError(error)
    }
    this.invalidateAllRefs()
    this.activeTabId = tabId
  }

  /** Close a tab and forget its cached state. */
  async closeTab(tabId) {
    try {
      await this.relay.call('close', { tabId })
    } catch (error) {
      throw asBridgeError(error)
    }
    this.dropTab(tabId)
    this.invalidateAllRefs()
  }
}
