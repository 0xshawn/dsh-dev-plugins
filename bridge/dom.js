/**
 * CDP DOM/Runtime helpers used by the tool handlers.
 *
 * These functions take the {@link import('./chrome.js').ChromeSession} as the
 * first argument, so tab state (attach-on-demand, refs, event invalidation)
 * stays in `chrome.js` and this module stays stateless.
 */
import { browserError } from './errors.js'

/** Page text included by `observe` (bounded so the MCP frame stays small). */
const PAGE_TEXT_LIMIT = 20000

const TRANSPORT_ERROR_CODES = ['bridge_disconnected', 'tab_unavailable', 'attach_failed', 'timeout']

function isTransportError(error) {
  return TRANSPORT_ERROR_CODES.includes(error?.code)
}

/** Current page URL and title. */
export async function pageInfo(session, tabId) {
  const response = await session.send(tabId, 'Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title })',
    returnByValue: true,
  })
  const value = response?.result?.value ?? {}
  const info = {
    url: typeof value.url === 'string' ? value.url : '',
    title: typeof value.title === 'string' ? value.title : '',
  }
  session.rememberUrl(tabId, info.url)
  return info
}

/** Visible page text, bounded for the MCP payload. */
export async function pageText(session, tabId) {
  const response = await session.send(tabId, 'Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  })
  const text = typeof response?.result?.value === 'string' ? response.result.value : ''
  return text.length > PAGE_TEXT_LIMIT ? text.slice(0, PAGE_TEXT_LIMIT) : text
}

/**
 * Collect visible interactive elements, assign refs `e1..eN`, and store
 * `{ backendNodeId, frameId, snapshotAt }` per ref.
 * @param session - Chrome session.
 * @param tabId - Chrome tab id.
 * @param options - `selector` root and `maxElements` cap.
 * @returns `{ elements, snapshotAt }`.
 */
export async function observe(session, tabId, { selector, maxElements = 100 } = {}) {
  const rootExpression = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document'
  const expression = `(() => {
    const root = ${rootExpression};
    if (!root) return null;
    const max = ${Math.max(1, Math.min(500, maxElements))};
    const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"],[role="textbox"],[role="combobox"],[role="searchbox"],[contenteditable=""],[contenteditable="true"],[tabindex]';
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (element.closest('[aria-hidden="true"]')) return false;
      return true;
    };
    const roleFor = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'range') return 'slider';
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        return 'textbox';
      }
      if (element.isContentEditable) return 'textbox';
      return element.getAttribute('tabindex') !== null ? 'generic' : 'group';
    };
    const nameFor = (element) => {
      const label = element.getAttribute('aria-label');
      if (label) return label.trim().slice(0, 160);
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
        if (text) return text.slice(0, 160);
      }
      const text = (element.innerText || element.value || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || '').trim();
      return text.slice(0, 160);
    };
    const elements = [];
    for (const element of root.querySelectorAll(INTERACTIVE)) {
      if (!isVisible(element)) continue;
      elements.push(element);
      if (elements.length >= max) break;
    }
    const descriptors = elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const descriptor = {
        ref: 'e' + (index + 1),
        role: roleFor(element),
        name: nameFor(element),
        tag: element.tagName.toLowerCase(),
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
      if (typeof element.value === 'string' && element.value !== '') descriptor.value = element.value;
      if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') descriptor.disabled = true;
      return descriptor;
    });
    return { nodes: elements, descriptorJson: JSON.stringify(descriptors) };
  })()`

  const remote = await session.send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: true,
  })
  if (typeof remote?.result?.objectId !== 'string') {
    throw browserError('selector_not_found', selector ? `No element matches selector ${selector}` : 'The page is not available')
  }
  const rootProps = await session.send(tabId, 'Runtime.getProperties', {
    objectId: remote.result.objectId,
    ownProperties: true,
  })
  const nodesProperty = rootProps?.result?.find((property) => property.name === 'nodes')
  const jsonProperty = rootProps?.result?.find((property) => property.name === 'descriptorJson')
  let descriptors = []
  try {
    descriptors = JSON.parse(jsonProperty?.value?.value ?? '[]')
  } catch {
    descriptors = []
  }
  if (!Array.isArray(descriptors)) descriptors = []

  const listProperties = nodesProperty?.value?.objectId
    ? await session.send(tabId, 'Runtime.getProperties', {
        objectId: nodesProperty.value.objectId,
        ownProperties: true,
      })
    : { result: [] }
  const objectIds = new Map()
  for (const property of listProperties.result ?? []) {
    if (/^\d+$/.test(property.name) && typeof property.value?.objectId === 'string') {
      objectIds.set(Number(property.name), property.value.objectId)
    }
  }

  const snapshotAt = Date.now()
  const described = await Promise.all(
    descriptors.map(async (descriptor, index) => {
      const objectId = objectIds.get(index)
      if (objectId === undefined) return null
      try {
        const { node } = await session.send(tabId, 'DOM.describeNode', { objectId })
        if (!Number.isInteger(node?.backendNodeId)) return null
        return { ref: descriptor.ref, descriptor, backendNodeId: node.backendNodeId, frameId: node.frameId, snapshotAt }
      } catch {
        return null
      }
    }),
  )
  const entries = []
  for (const item of described) {
    if (item !== null) entries.push([item.ref, { backendNodeId: item.backendNodeId, frameId: item.frameId, snapshotAt }])
  }
  session.refStore(tabId).set(entries, snapshotAt)
  return { elements: described.filter((item) => item !== null).map((item) => item.descriptor), snapshotAt }
}

/**
 * Resolve a `ref` (preferred) or CSS `selector` to a CDP node identity.
 * @returns `{ backendNodeId?, nodeId?, objectId? }`.
 */
export async function resolveNode(session, tabId, { ref, selector } = {}) {
  if (ref !== undefined) {
    const entry = session.resolveRef(tabId, ref)
    try {
      const resolved = await session.send(tabId, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId })
      return { backendNodeId: entry.backendNodeId, objectId: resolved?.object?.objectId }
    } catch (error) {
      if (isTransportError(error)) throw error
      throw browserError('stale_ref', `Ref ${ref} no longer points at a live element; call observe again.`)
    }
  }
  if (typeof selector === 'string' && selector !== '') {
    const { root } = await session.send(tabId, 'DOM.getDocument', { depth: 0 })
    const { nodeId } = await session.send(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw browserError('selector_not_found', `No element matches selector ${selector}`)
    const { node } = await session.send(tabId, 'DOM.describeNode', { nodeId })
    return { nodeId, backendNodeId: node?.backendNodeId }
  }
  throw browserError('invalid_params', 'A ref or selector is required')
}

export async function objectIdFor(session, tabId, target) {
  if (typeof target.objectId === 'string') return target.objectId
  const resolved = await session.send(tabId, 'DOM.resolveNode', { backendNodeId: target.backendNodeId })
  return resolved?.object?.objectId
}

/** Scroll a node into view (best effort) before reading its box. */
export async function scrollIntoView(session, tabId, target) {
  if (!Number.isInteger(target.backendNodeId)) return
  try {
    await session.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId })
  } catch {
    /* detached nodes fail here; the box lookup reports the real error */
  }
}

/**
 * Element box in viewport CSS pixels.
 * @returns `{ x, y, left, top, width, height }`, where x/y is the centre.
 */
export async function boxCenter(session, tabId, target) {
  let model
  try {
    model = await session.send(
      tabId,
      'DOM.getBoxModel',
      Number.isInteger(target.backendNodeId)
        ? { backendNodeId: target.backendNodeId }
        : { objectId: await objectIdFor(session, tabId, target) },
    )
  } catch (error) {
    if (isTransportError(error)) throw error
    throw browserError('stale_ref', 'The element no longer has a layout box; call observe again.')
  }
  const quad = model?.model?.content
  if (!Array.isArray(quad) || quad.length < 8) {
    throw browserError('stale_ref', 'The element no longer has a layout box; call observe again.')
  }
  const points = []
  for (let index = 0; index < quad.length; index += 2) points.push({ x: quad[index], y: quad[index + 1] })
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    x: (left + Math.max(...xs)) / 2,
    y: (top + Math.max(...ys)) / 2,
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  }
}

/** Focus a resolved node. */
export async function focus(session, tabId, target) {
  const objectId = await objectIdFor(session, tabId, target)
  if (objectId === undefined) throw browserError('stale_ref', 'The element is no longer available; call observe again.')
  await session.send(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { this.focus(); }',
    awaitPromise: false,
  })
}

/** Scroll a target node's content by the given deltas. */
export async function scrollNode(session, tabId, target, deltaX, deltaY) {
  const objectId = await objectIdFor(session, tabId, target)
  if (objectId === undefined) throw browserError('stale_ref', 'The element is no longer available; call observe again.')
  await session.send(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function (dx, dy) { this.scrollBy(dx, dy); }',
    arguments: [{ value: deltaX }, { value: deltaY }],
    awaitPromise: false,
  })
}

/** Set files on a file input. */
export async function setFiles(session, tabId, target, files) {
  const params = { files }
  if (Number.isInteger(target.backendNodeId)) params.backendNodeId = target.backendNodeId
  else params.objectId = await objectIdFor(session, tabId, target)
  await session.send(tabId, 'DOM.setFileInputFiles', params)
}

/** Capture a PNG screenshot; `fullPage` uses the content size as clip. */
export async function captureScreenshot(session, tabId, { fullPage = false, clip } = {}) {
  const params = { format: 'png', fromSurface: true }
  if (clip !== undefined) {
    params.clip = { ...clip, scale: 1 }
  } else if (fullPage) {
    const metrics = await session.send(tabId, 'Page.getLayoutMetrics', {})
    const size = metrics?.cssContentSize ?? metrics?.contentSize
    if (size !== undefined && Number(size.width) > 0 && Number(size.height) > 0) {
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
      params.captureBeyondViewport = true
    }
  }
  const result = await session.send(tabId, 'Page.captureScreenshot', params)
  return typeof result?.data === 'string' ? result.data : ''
}
