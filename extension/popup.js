'use strict'

/** Popup state refresh cadence while the popup stays open. */
const REFRESH_MS = 1000

const elements = {
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  portInput: document.getElementById('port-input'),
  tokenInput: document.getElementById('token-input'),
  settingsForm: document.getElementById('settings-form'),
  saveButton: document.getElementById('save-button'),
  connectButton: document.getElementById('connect-button'),
  disconnectButton: document.getElementById('disconnect-button'),
  attachedList: document.getElementById('attached-list'),
  attachedEmpty: document.getElementById('attached-empty'),
  lastError: document.getElementById('last-error'),
}

/**
 * Send one message to the background worker.
 * @param type - popup message type.
 * @param payload - extra fields merged into the message.
 * @returns the worker response, or undefined when the worker is unavailable.
 */
async function sendMessage(type, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...payload })
  } catch {
    return undefined
  }
}

/** Render one attached-tab row, truncated by CSS. */
function renderAttachedRow(tab) {
  const item = document.createElement('li')
  item.className = 'tab-item'
  const title = document.createElement('span')
  title.className = 'tab-title'
  title.textContent = tab.title === '' ? '(untitled tab)' : tab.title
  const url = document.createElement('span')
  url.className = 'tab-url'
  url.textContent = tab.url
  item.append(title, url)
  return item
}

/** Apply one worker state snapshot to the popup DOM. */
function renderState(state) {
  if (state === null || typeof state !== 'object') return
  const connected = state.connected === true
  elements.statusDot.dataset.status = connected ? 'connected' : state.lastError ? 'error' : 'disconnected'
  elements.statusText.textContent = connected ? 'Connected' : 'Disconnected'
  elements.connectButton.textContent = connected ? 'Reconnect' : 'Connect'

  if (document.activeElement !== elements.portInput && state.port !== undefined) {
    elements.portInput.value = String(state.port)
  }
  if (document.activeElement !== elements.tokenInput && typeof state.token === 'string') {
    elements.tokenInput.value = state.token
  }

  const attached = Array.isArray(state.attached) ? state.attached : []
  elements.attachedList.replaceChildren(...attached.map(renderAttachedRow))
  elements.attachedEmpty.hidden = attached.length > 0

  const error = typeof state.lastError === 'string' && state.lastError !== '' ? state.lastError : ''
  elements.lastError.hidden = error === ''
  elements.lastError.textContent = error
}

/** Refresh the popup from the worker. */
async function refresh() {
  const reply = await sendMessage('get-state')
  if (reply !== null && typeof reply === 'object' && reply.ok === true) renderState(reply.state)
}

/** Persist the port/token inputs from the settings form. */
async function saveSettings(event) {
  event.preventDefault()
  elements.saveButton.disabled = true
  const reply = await sendMessage('save-settings', {
    token: elements.tokenInput.value,
    port: Number.parseInt(elements.portInput.value, 10),
  })
  elements.saveButton.disabled = false
  if (reply !== null && typeof reply === 'object' && reply.ok === true) renderState(reply.state)
}

/** Reconnect (or connect) to the bridge. */
async function reconnectBridge() {
  elements.connectButton.disabled = true
  const reply = await sendMessage('reconnect')
  elements.connectButton.disabled = false
  if (reply !== null && typeof reply === 'object') renderState(reply.state)
}

/** Close the socket and stay disconnected until Connect is pressed. */
async function disconnectBridge() {
  const reply = await sendMessage('disconnect')
  if (reply !== null && typeof reply === 'object') renderState(reply.state)
}

elements.settingsForm.addEventListener('submit', (event) => {
  void saveSettings(event)
})
elements.connectButton.addEventListener('click', () => {
  void reconnectBridge()
})
elements.disconnectButton.addEventListener('click', () => {
  void disconnectBridge()
})

void refresh()
setInterval(() => {
  void refresh()
}, REFRESH_MS)
