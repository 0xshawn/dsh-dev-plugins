/**
 * Shared browser-control errors. Tool failures carry a stable code that ends
 * up in the MCP text payload as `<code>: <message>`.
 */
import { BridgeError } from './relay.js'

/**
 * @param code - stable error code (for example `stale_ref`).
 * @param message - operator-facing message.
 */
export function browserError(code, message) {
  return new BridgeError(code, message)
}

/**
 * Normalize relay/extension failures into a {@link BridgeError}.
 * @param error - error from a relay call.
 * @param fallbackCode - code used when the error carries none.
 */
export function asBridgeError(error, fallbackCode = 'extension_error') {
  if (error instanceof BridgeError) return error
  return new BridgeError(fallbackCode, error instanceof Error ? error.message : String(error))
}
