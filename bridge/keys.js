/**
 * Keyboard chord parsing for the `key`, `type`, and `click` tools.
 *
 * The protocol document fixes the modifier masks as 2/8/1/4 for
 * Ctrl/Meta/Alt/Shift; keep them here so every call site agrees.
 */
import { BridgeError } from './relay.js'

/** CDP modifier masks, in the protocol document's order. */
export const MODIFIER_MASKS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

const MODIFIER_ALIASES = {
  alt: 'Alt',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  shift: 'Shift',
}

const SPECIAL_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

function toolError(code, message) {
  return new BridgeError(code, message)
}

function canonicalModifier(name) {
  return MODIFIER_ALIASES[String(name ?? '').trim().toLowerCase()]
}

/**
 * Format a chord such as `Control+A`, `Shift+Enter`, or `Meta+ArrowLeft` into
 * the fields `Input.dispatchKeyEvent` needs.
 * @param chord - `Modifier+...` chord, `+` separated.
 * @returns `{ modifiers, key, code, windowsVirtualKeyCode, text? }`.
 */
export function formatKeyChord(chord) {
  if (typeof chord !== 'string' || chord.trim() === '') {
    throw toolError('invalid_params', 'keys must be a non-empty chord such as "Control+A"')
  }
  const parts = chord
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) throw toolError('invalid_params', `Invalid key chord: ${chord}`)

  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const modifier = canonicalModifier(part)
    if (modifier === undefined) throw toolError('invalid_params', `Unknown modifier "${part}" in chord ${chord}`)
    modifiers |= MODIFIER_MASKS[modifier]
  }

  const name = parts[parts.length - 1]
  const shifted = (modifiers & MODIFIER_MASKS.Shift) !== 0
  const special = SPECIAL_KEYS[name] ?? SPECIAL_KEYS[name.charAt(0).toUpperCase() + name.slice(1)]
  if (special !== undefined) return { modifiers, ...special }

  const functionKey = /^F([1-9]|1[0-2])$/.exec(name.toUpperCase())
  if (functionKey !== null) {
    return {
      modifiers,
      key: name.toUpperCase(),
      code: name.toUpperCase(),
      windowsVirtualKeyCode: 111 + Number(functionKey[1]),
    }
  }

  if (/^[a-zA-Z]$/.test(name)) {
    const upper = name.toUpperCase()
    return {
      modifiers,
      key: shifted ? upper : upper.toLowerCase(),
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: shifted ? upper : upper.toLowerCase(),
    }
  }
  if (/^[0-9]$/.test(name)) {
    return { modifiers, key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0), text: name }
  }
  if (name.length === 1) {
    return { modifiers, key: name, code: '', windowsVirtualKeyCode: 0, text: name }
  }
  throw toolError('invalid_params', `Unknown key "${name}" in chord ${chord}`)
}

/**
 * Fold a click `modifiers` parameter (names or a ready mask) into a CDP mask.
 * @param value - array of modifier names, a number, or undefined.
 */
export function modifiersMask(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (value === undefined || value === null) return 0
  if (!Array.isArray(value)) throw toolError('invalid_params', 'modifiers must be an array of modifier names')
  let mask = 0
  for (const name of value) {
    const modifier = canonicalModifier(name)
    if (modifier === undefined) throw toolError('invalid_params', `Unknown modifier "${name}"`)
    mask |= MODIFIER_MASKS[modifier]
  }
  return mask
}
