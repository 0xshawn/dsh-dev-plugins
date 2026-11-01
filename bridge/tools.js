/**
 * The 16 MCP tools exposed by the browser-control bridge.
 *
 * Every handler resolves the active tab through `ChromeSession`, returns a
 * plain payload (rendered as one JSON text block) and, for screenshot calls,
 * an extra PNG image block. Pure helpers are re-exported here so
 * `test/bridge.test.mjs` can cover them without a browser.
 */
import { basename } from 'node:path'

import { z } from 'zod'

import { auditToolCall } from './audit.js'
import { saveDownload } from './download.js'
import {
  boxCenter,
  captureScreenshot,
  elementClip,
  focus,
  observe as observeDom,
  objectIdFor,
  pageInfo,
  pageText,
  resolveNode,
  scrollIntoView,
  scrollNode,
  setFiles,
} from './dom.js'
import { browserError } from './errors.js'
import { formatKeyChord, modifiersMask } from './keys.js'
import { readNetworkBody } from './network.js'
import { resolveUploadPaths, summarizeParams } from './paths.js'

export { sanitizeDownloadFilename, saveDownload } from './download.js'
export { formatKeyChord, MODIFIER_MASKS } from './keys.js'
export { isWithinRoots, resolveUploadPaths, summarizeParams } from './paths.js'

const toolError = browserError

function textResult(payload, image) {
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
  if (image !== undefined) content.push({ type: 'image', data: image.data, mimeType: 'image/png' })
  return { content }
}

function errorResult(code, message) {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true }
}

function requireTabId(params) {
  if (!Number.isInteger(params.tabId)) throw toolError('invalid_params', 'tabId is required for this operation')
  return params.tabId
}

function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(toolError('timeout', message)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Cap for one `evaluate` result; larger values fail with `evaluate_too_large`. */
export const EVALUATE_RESULT_LIMIT_BYTES = 1024 * 1024

/**
 * Platform select-all chord for elements without a native `select()` method
 * (contenteditable). macOS uses Meta+A, everything else Control+A.
 * @param platform - `process.platform` value; injectable for tests.
 */
export function selectAllChord(platform = process.platform) {
  return formatKeyChord(platform === 'darwin' ? 'Meta+A' : 'Control+A')
}

async function evaluateValue(session, tabId, expression) {
  const response = await session.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response?.exceptionDetails) {
    throw toolError(
      'evaluate_error',
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'The expression threw',
    )
  }
  return response?.result?.value
}

const tabsTool = {
  description: 'List, open, select, or close browser tabs.',
  schema: z.object({
    op: z.enum(['list', 'new', 'select', 'close']).describe('Operation.'),
    tabId: z.number().int().optional().describe('Tab id for select/close.'),
    url: z.string().optional().describe('URL to open for new.'),
  }),
  async handler(params, { session }) {
    switch (params.op) {
      case 'list': {
        const targets = await session.listTargets({ fresh: true })
        return {
          tabs: targets.map((target) => ({
            tabId: target.tabId,
            targetId: target.targetId,
            url: target.url ?? '',
            title: target.title ?? '',
            active: target.tabId === session.activeTabId,
          })),
        }
      }
      case 'new':
        return session.createTab(params.url ?? 'about:blank')
      case 'select': {
        const tabId = requireTabId(params)
        await session.activateTab(tabId)
        return { tabId, active: true }
      }
      case 'close': {
        const tabId = requireTabId(params)
        await session.closeTab(tabId)
        return { tabId, closed: true }
      }
      default:
        throw toolError('invalid_params', `Unknown tabs operation ${params.op}`)
    }
  },
}

const navigateTool = {
  description: 'Navigate the active tab: open a URL, go back/forward, or reload.',
  schema: z.object({
    url: z.string().optional().describe('URL to navigate to.'),
    back: z.boolean().optional().describe('Go back in history.'),
    forward: z.boolean().optional().describe('Go forward in history.'),
    reload: z.boolean().optional().describe('Reload the current page.'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'none']).optional().describe('Navigation wait condition (default load).'),
  }),
  async handler(params, { session }) {
    const verbs = [params.url !== undefined, params.back === true, params.forward === true, params.reload === true].filter(
      Boolean,
    ).length
    if (verbs !== 1) throw toolError('invalid_params', 'navigate needs exactly one of url, back, forward, reload')
    const tabId = await session.ensureActiveTab()
    if (params.url !== undefined) {
      const navigation = await session.send(tabId, 'Page.navigate', { url: params.url })
      if (typeof navigation?.errorText === 'string' && navigation.errorText !== '') {
        throw toolError('navigate_failed', `Navigation failed: ${navigation.errorText}`)
      }
    } else if (params.back === true || params.forward === true) {
      const history = await session.send(tabId, 'Page.getNavigationHistory', {})
      const index = Number(history.currentIndex) + (params.forward === true ? 1 : -1)
      const entry = history.entries?.[index]
      if (entry === undefined) {
        throw toolError(
          'navigate_failed',
          `No navigation history entry to go ${params.forward === true ? 'forward' : 'back'} to`,
        )
      }
      await session.send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id })
    } else {
      await session.send(tabId, 'Page.reload', {})
    }
    const waitUntil = params.waitUntil ?? 'load'
    if (waitUntil !== 'none') await session.waitForLoad(tabId, waitUntil)
    const info = await pageInfo(session, tabId)
    return { url: info.url, title: info.title }
  },
}

const observeTool = {
  description: 'Snapshot visible interactive elements as refs (e1..eN) plus page text.',
  schema: z.object({
    selector: z.string().optional().describe('Restrict the scan to a CSS selector.'),
    maxElements: z.number().int().min(1).max(500).optional().describe('Maximum elements (default 100).'),
    screenshot: z.boolean().optional().describe('Also capture a PNG screenshot.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const info = await pageInfo(session, tabId)
    const text = await pageText(session, tabId)
    const { elements, snapshotAt } = await observeDom(session, tabId, {
      selector: params.selector,
      maxElements: params.maxElements ?? 100,
    })
    const payload = { url: info.url, title: info.title, text, elements, refsInvalidatedAt: snapshotAt }
    if (params.screenshot === true) {
      const data = await captureScreenshot(session, tabId, {})
      return { payload, image: { data } }
    }
    return payload
  },
}

const screenshotTool = {
  description: 'Capture the active tab (or one element) as a PNG image.',
  schema: z.object({
    fullPage: z.boolean().optional().describe('Capture the whole page instead of the viewport.'),
    ref: z.string().optional().describe('Element ref from observe.'),
    selector: z.string().optional().describe('CSS selector for the element.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    let clip
    if (params.ref !== undefined || params.selector !== undefined) {
      const target = await resolveNode(session, tabId, params)
      clip = await elementClip(session, tabId, target)
    }
    const data = await captureScreenshot(session, tabId, { fullPage: params.fullPage === true, clip })
    const info = await pageInfo(session, tabId)
    return { payload: { url: info.url, title: info.title }, image: { data } }
  },
}

const waitTool = {
  description: 'Wait for a selector, a text, or network idle (default timeout 15 s).',
  schema: z.object({
    selector: z.string().optional().describe('Wait until this selector matches.'),
    text: z.string().optional().describe('Wait until the page text contains this string.'),
    networkIdle: z.boolean().optional().describe('Wait until the network has been idle.'),
    timeoutMs: z.number().int().min(1).optional().describe('Timeout in milliseconds (default 15000).'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    if (params.selector === undefined && params.text === undefined && params.networkIdle !== true) {
      throw toolError('invalid_params', 'wait needs one of selector, text, networkIdle')
    }
    const condition = await session.waitForFirst(
      tabId,
      { selector: params.selector, text: params.text, networkIdle: params.networkIdle === true },
      params.timeoutMs ?? 15000,
    )
    return { ok: true, condition }
  },
}

const clickTool = {
  description: 'Click an element (by ref or selector) with real mouse events at its box centre.',
  schema: z.object({
    ref: z.string().optional().describe('Element ref from observe (preferred).'),
    selector: z.string().optional().describe('CSS selector fallback.'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left).'),
    clickCount: z.number().int().min(1).max(3).optional().describe('Number of clicks (default 1).'),
    modifiers: z
      .union([z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])), z.number().int()])
      .optional()
      .describe('Modifier names or a CDP modifier mask.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const target = await resolveNode(session, tabId, params)
    await scrollIntoView(session, tabId, target)
    const point = await boxCenter(session, tabId, target)
    const button = params.button ?? 'left'
    const clickCount = params.clickCount ?? 1
    const modifiers = modifiersMask(params.modifiers)
    for (let count = 1; count <= clickCount; count += 1) {
      await session.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount: count,
        modifiers,
      })
      await session.send(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount: count,
        modifiers,
      })
    }
    return { clicked: true, x: Math.round(point.x), y: Math.round(point.y), button, clickCount }
  },
}

/**
 * Select the contents of a resolved element. HTML input/textarea elements
 * expose `select()`; contenteditable falls back to the platform chord.
 */
async function selectAll(session, tabId, target) {
  if (target !== undefined) {
    const objectId = await objectIdFor(session, tabId, target)
    if (typeof objectId === 'string') {
      const response = await session.send(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function () { try { if (typeof this.select === "function") { this.select(); return true } } catch (error) { return false } return false }',
        returnByValue: true,
        awaitPromise: false,
      })
      if (response?.result?.value === true) return
    }
  }
  await session.pressChord(tabId, selectAllChord())
}

const typeTool = {
  description: 'Type text into an element or the focused element.',
  schema: z.object({
    ref: z.string().optional().describe('Element ref from observe.'),
    selector: z.string().optional().describe('CSS selector fallback.'),
    text: z.string().describe('Text to type.'),
    submit: z.boolean().optional().describe('Press Enter afterwards.'),
    clear: z.boolean().optional().describe('Select existing content first.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    let target
    if (params.ref !== undefined || params.selector !== undefined) {
      target = await resolveNode(session, tabId, params)
      await focus(session, tabId, target)
    }
    if (params.clear === true) await selectAll(session, tabId, target)
    if (params.text !== '') {
      await session.send(tabId, 'Input.insertText', { text: params.text })
    } else if (params.clear === true) {
      // Selecting everything leaves the old content selected; delete it.
      await session.pressChord(tabId, formatKeyChord('Backspace'))
    }
    if (params.submit === true) await session.pressChord(tabId, formatKeyChord('Enter'))
    return { typed: true, length: params.text.length, cleared: params.clear === true, submitted: params.submit === true }
  },
}

const keyTool = {
  description: 'Press keyboard chords such as "Control+A", "Shift+Enter", or "Meta+ArrowLeft".',
  schema: z.object({
    keys: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe('One chord, a comma-separated list, or an array of chords.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const chords = Array.isArray(params.keys)
      ? params.keys
      : String(params.keys)
          .split(',')
          .map((chord) => chord.trim())
          .filter((chord) => chord !== '')
    if (chords.length === 0) throw toolError('invalid_params', 'keys must contain at least one chord')
    for (const chord of chords) await session.pressChord(tabId, formatKeyChord(chord))
    return { sent: chords }
  },
}

const scrollTool = {
  description: 'Scroll the page or an element by deltas, or to the top/bottom.',
  schema: z.object({
    ref: z.string().optional().describe('Element ref to scroll.'),
    selector: z.string().optional().describe('CSS selector fallback.'),
    deltaX: z.number().optional().describe('Horizontal delta in pixels.'),
    deltaY: z.number().optional().describe('Vertical delta in pixels.'),
    toTop: z.boolean().optional().describe('Scroll to the top.'),
    toBottom: z.boolean().optional().describe('Scroll to the bottom.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const hasTarget = params.ref !== undefined || params.selector !== undefined
    const target = hasTarget ? await resolveNode(session, tabId, params) : undefined
    if (params.toTop === true || params.toBottom === true) {
      if (target !== undefined) {
        const objectId = await objectIdFor(session, tabId, target)
        await session.send(tabId, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function (edge) { this.scrollTo({ top: edge === "top" ? 0 : this.scrollHeight }); }',
          arguments: [{ value: params.toTop === true ? 'top' : 'bottom' }],
        })
      } else {
        const expression =
          params.toTop === true ? 'window.scrollTo(0, 0)' : 'window.scrollTo(0, document.documentElement.scrollHeight)'
        await session.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true })
      }
      return { scrolled: true, to: params.toTop === true ? 'top' : 'bottom' }
    }
    const deltaX = params.deltaX ?? 0
    const deltaY = params.deltaY ?? 0
    if (deltaX === 0 && deltaY === 0) throw toolError('invalid_params', 'scroll needs deltas or toTop/toBottom')
    if (target !== undefined) {
      await scrollIntoView(session, tabId, target)
      await scrollNode(session, tabId, target, deltaX, deltaY)
      return { scrolled: true, deltaX, deltaY, target: 'element' }
    }
    const metrics = await session.send(tabId, 'Page.getLayoutMetrics', {})
    const viewport = metrics?.cssLayoutViewport
    const x = Math.round((viewport?.clientWidth ?? 800) / 2)
    const y = Math.round((viewport?.clientHeight ?? 600) / 2)
    await session.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
    return { scrolled: true, deltaX, deltaY, target: 'viewport' }
  },
}

const dialogTool = {
  description: 'Accept or dismiss the pending JavaScript dialog; reports pending: false when none is open.',
  schema: z.object({
    accept: z.boolean().describe('Accept (true) or dismiss (false) the dialog.'),
    promptText: z.string().optional().describe('Text for prompt() dialogs.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    if (session.pendingDialog(tabId) === undefined) return { pending: false }
    const dialogParams = { accept: params.accept }
    if (params.promptText !== undefined) dialogParams.promptText = params.promptText
    await session.send(tabId, 'Page.handleJavaScriptDialog', dialogParams)
    session.clearDialog(tabId)
    return { pending: true, accepted: params.accept === true }
  },
}

const evaluateTool = {
  description: 'Evaluate an expression in the page main world and return its JSON value.',
  schema: z.object({
    expression: z.string().describe('JavaScript expression.'),
    awaitPromise: z.boolean().optional().describe('Await the expression when it returns a promise.'),
    timeoutMs: z.number().int().min(1).optional().describe('Timeout in milliseconds (default 10000).'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const timeoutMs = params.timeoutMs ?? 10000
    let response
    try {
      response = await withTimeout(
        session.send(tabId, 'Runtime.evaluate', {
          expression: params.expression,
          awaitPromise: params.awaitPromise === true,
          returnByValue: true,
          userGesture: true,
        }),
        timeoutMs,
        `Evaluation timed out after ${timeoutMs} ms`,
      )
    } catch (error) {
      if (['timeout', 'bridge_disconnected', 'tab_unavailable', 'stale_ref', 'attach_failed'].includes(error?.code)) throw error
      throw toolError('evaluate_unserializable', error instanceof Error ? error.message : String(error))
    }
    if (response?.exceptionDetails) {
      throw toolError(
        'evaluate_error',
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'The expression threw',
      )
    }
    const result = response?.result
    if (result === undefined || result === null || result.type === 'undefined' || result.value === undefined) {
      throw toolError('evaluate_unserializable', 'The expression returned undefined or a value that JSON cannot represent')
    }
    // Results are capped instead of truncated: a partial JSON value would be
    // misleading. 1 MB is far above any practical tool payload.
    const serialized = JSON.stringify(result.value)
    if (Buffer.byteLength(serialized, 'utf8') > EVALUATE_RESULT_LIMIT_BYTES) {
      throw toolError(
        'evaluate_too_large',
        `Evaluation result exceeds ${EVALUATE_RESULT_LIMIT_BYTES} bytes; return a smaller value from the page`,
      )
    }
    return { result: result.value }
  },
}

const networkTool = {
  description: 'Record and inspect network requests: start, stop, list, body, or clear.',
  schema: z.object({
    op: z.enum(['start', 'stop', 'list', 'body', 'clear']).describe('Operation.'),
    requestId: z.string().optional().describe('Request id for body.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    switch (params.op) {
      case 'start':
        await session.startNetwork(tabId)
        return { recording: true }
      case 'stop':
        await session.stopNetwork(tabId)
        return { recording: false, requests: session.network.size }
      case 'list':
        return { recording: session.recording, requests: session.network.list() }
      case 'clear':
        session.network.clear()
        return { cleared: true }
      case 'body': {
        if (typeof params.requestId !== 'string' || params.requestId === '') {
          throw toolError('invalid_params', 'requestId is required for network body')
        }
        return readNetworkBody(session, params.requestId)
      }
      default:
        throw toolError('invalid_params', `Unknown network operation ${params.op}`)
    }
  },
}

const uploadTool = {
  description: 'Set files on a file input; paths must resolve inside the configured upload roots.',
  schema: z.object({
    ref: z.string().optional().describe('Element ref from observe.'),
    selector: z.string().optional().describe('CSS selector fallback.'),
    paths: z.array(z.string()).min(1).describe('Absolute or ~ paths to upload.'),
  }),
  async handler(params, { session, config }) {
    const tabId = await session.ensureActiveTab()
    const target = await resolveNode(session, tabId, params)
    const files = await resolveUploadPaths(params.paths, config.uploadRoots)
    await setFiles(session, tabId, target, files)
    return { count: files.length, files: files.map((file) => basename(file)) }
  },
}

const downloadTool = {
  description: 'Download an http(s) URL into the configured bridge download directory, or list Chrome download history.',
  schema: z.object({
    op: z.enum(['list', 'url']).describe('Operation.'),
    url: z.string().optional().describe('http(s) URL to download for op "url".'),
    filename: z.string().optional().describe('Optional safe file name (default from the URL path).'),
  }),
  async handler(params, { session, config }) {
    switch (params.op) {
      case 'list':
        return { downloads: await session.listDownloads() }
      case 'url': {
        const saved = await saveDownload({
          downloadDir: config.downloadDir,
          url: params.url,
          filename: params.filename,
        })
        return { payload: saved, savedPath: saved.path }
      }
      default:
        throw toolError('invalid_params', `Unknown download operation ${params.op}`)
    }
  },
}

const cookiesTool = {
  description: 'Read, set, or clear cookies through the CDP Network domain.',
  schema: z.object({
    op: z.enum(['get', 'set', 'clear']).describe('Operation.'),
    urls: z.array(z.string()).optional().describe('URLs to scope get/clear.'),
    cookies: z.array(z.record(z.string(), z.unknown())).optional().describe('Cookies for set.'),
    name: z.string().optional().describe('Cookie name for clear.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    switch (params.op) {
      case 'get': {
        const urls = params.urls ?? (session.urlFor(tabId) !== undefined ? [session.urlFor(tabId)] : undefined)
        const result = await session.send(tabId, 'Network.getCookies', urls === undefined ? {} : { urls })
        return { cookies: result?.cookies ?? [] }
      }
      case 'set': {
        const cookies = params.cookies ?? []
        if (cookies.length === 0) throw toolError('invalid_params', 'cookies is required for cookies set')
        for (const cookie of cookies) await session.send(tabId, 'Network.setCookie', cookie)
        return { count: cookies.length }
      }
      case 'clear': {
        if (typeof params.name === 'string' && params.name !== '') {
          // CDP rejects deleteCookies without a url or domain.
          const url = params.urls?.[0] ?? session.urlFor(tabId)
          if (typeof url !== 'string' || url === '') {
            throw toolError(
              'invalid_params',
              'cookies clear by name needs a url: pass urls or open a page first',
            )
          }
          await session.send(tabId, 'Network.deleteCookies', { name: params.name, url })
          return { cleared: true, name: params.name }
        }
        await session.send(tabId, 'Network.clearBrowserCookies', {})
        return { cleared: true }
      }
      default:
        throw toolError('invalid_params', `Unknown cookies operation ${params.op}`)
    }
  },
}

const storageTool = {
  description: 'Read, set, or clear local/session storage string values.',
  schema: z.object({
    op: z.enum(['get', 'set', 'clear']).describe('Operation.'),
    area: z.enum(['local', 'session']).optional().describe('Storage area (default local).'),
    key: z.string().optional().describe('Storage key.'),
    value: z.string().optional().describe('String value for set.'),
  }),
  async handler(params, { session }) {
    const tabId = await session.ensureActiveTab()
    const area = params.area === 'session' ? 'sessionStorage' : 'localStorage'
    switch (params.op) {
      case 'get': {
        if (params.key !== undefined) {
          const value = await evaluateValue(session, tabId, `${area}.getItem(${JSON.stringify(params.key)})`)
          return { key: params.key, value: value ?? null }
        }
        const json = await evaluateValue(session, tabId, `JSON.stringify(Object.fromEntries(Object.entries(${area})))`)
        let values = {}
        try {
          values = JSON.parse(json ?? '{}')
        } catch {
          values = {}
        }
        return { values }
      }
      case 'set': {
        if (params.key === undefined || params.value === undefined) {
          throw toolError('invalid_params', 'storage set needs key and value')
        }
        await evaluateValue(session, tabId, `${area}.setItem(${JSON.stringify(params.key)}, ${JSON.stringify(params.value)})`)
        return { key: params.key, ok: true }
      }
      case 'clear': {
        if (params.key !== undefined) {
          await evaluateValue(session, tabId, `${area}.removeItem(${JSON.stringify(params.key)})`)
          return { cleared: true, key: params.key }
        }
        await evaluateValue(session, tabId, `${area}.clear()`)
        return { cleared: true }
      }
      default:
        throw toolError('invalid_params', `Unknown storage operation ${params.op}`)
    }
  },
}

/** Tool definitions in registration order. */
const TOOL_DEFINITIONS = [
  { name: 'tabs', ...tabsTool },
  { name: 'navigate', ...navigateTool },
  { name: 'observe', ...observeTool },
  { name: 'screenshot', ...screenshotTool },
  { name: 'wait', ...waitTool },
  { name: 'click', ...clickTool },
  { name: 'type', ...typeTool },
  { name: 'key', ...keyTool },
  { name: 'scroll', ...scrollTool },
  { name: 'dialog', ...dialogTool },
  { name: 'evaluate', ...evaluateTool },
  { name: 'network', ...networkTool },
  { name: 'upload', ...uploadTool },
  { name: 'download', ...downloadTool },
  { name: 'cookies', ...cookiesTool },
  { name: 'storage', ...storageTool },
]

/** Names of all tools the bridge can register. */
export const TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.name)

/**
 * Register enabled tools on one MCP server. Disabled tools are not registered,
 * so `tools/list` omits them.
 * @param server - `McpServer` instance.
 * @param session - {@link import('./chrome.js').ChromeSession}.
 * @param config - parsed bridge configuration.
 */
export function registerTools(server, session, config = {}) {
  const disabled = new Set(config.disabledTools ?? [])
  for (const definition of TOOL_DEFINITIONS) {
    if (disabled.has(definition.name)) continue
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.schema },
      async (params) => {
        const started = Date.now()
        const fallbackTabId = session.activeTabId ?? undefined
        const auditPaths = (result) => {
          if (definition.name === 'upload') return params.paths
          if (definition.name === 'download' && typeof result?.savedPath === 'string') return [result.savedPath]
          return undefined
        }
        try {
          const outcome = await definition.handler(params, { session, config })
          const tabId = session.activeTabId ?? fallbackTabId
          await auditToolCall(config.home, {
            tool: definition.name,
            paramsSummary: summarizeParams(definition.name, params),
            tabId,
            url: tabId === undefined ? undefined : session.urlFor(tabId),
            paths: auditPaths(outcome),
            ok: true,
            ms: Date.now() - started,
          })
          const payload =
            outcome !== null && typeof outcome === 'object' && 'payload' in outcome ? outcome.payload : outcome
          return textResult(payload, outcome?.image)
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'tool_failed'
          const message = error instanceof Error ? error.message : String(error)
          await auditToolCall(config.home, {
            tool: definition.name,
            paramsSummary: summarizeParams(definition.name, params),
            tabId: session.activeTabId ?? fallbackTabId,
            paths: auditPaths(undefined),
            ok: false,
            ms: Date.now() - started,
            error: code,
          })
          return errorResult(code, message)
        }
      },
    )
  }
}
