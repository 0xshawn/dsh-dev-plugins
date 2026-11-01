/**
 * Path guards and audit summaries shared by the tool handlers.
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { BridgeError } from './relay.js'

function toolError(code, message) {
  return new BridgeError(code, message)
}

/**
 * Whether a resolved path lives inside one of the roots. Uses path segments,
 * so `/root/foo` is not considered inside `/root/foobar`.
 * @param targetPath - absolute path to test.
 * @param roots - allowed absolute roots.
 */
export function isWithinRoots(targetPath, roots) {
  const target = resolve(targetPath)
  return (roots ?? []).some((root) => {
    const base = resolve(root)
    const rel = relative(base, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

/**
 * Resolve upload paths to real files inside the allowed roots. Symlinks are
 * resolved before the root check, so a link inside a root that points outside
 * is rejected.
 * @param paths - operator-provided paths.
 * @param roots - allowed upload roots.
 * @returns canonical absolute file paths.
 */
export async function resolveUploadPaths(paths, roots) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw toolError('invalid_params', 'paths must contain at least one file')
  }
  const canonicalRoots = []
  for (const root of roots ?? []) {
    const absoluteRoot = resolve(root)
    try {
      canonicalRoots.push(await realpath(absoluteRoot))
    } catch {
      canonicalRoots.push(absoluteRoot)
    }
  }
  const resolved = []
  for (const input of paths) {
    if (typeof input !== 'string' || input.trim() === '') {
      throw toolError('invalid_params', 'each upload path must be a non-empty string')
    }
    const absolute = resolve(input)
    let canonical
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      if (error?.code === 'ENOENT') throw toolError('upload_path_missing', `${absolute} does not exist`)
      throw toolError('upload_path_denied', `${absolute} cannot be resolved: ${error instanceof Error ? error.message : error}`)
    }
    if (!isWithinRoots(canonical, canonicalRoots)) {
      throw toolError('upload_path_denied', `${canonical} is outside the allowed upload roots`)
    }
    let info
    try {
      info = await stat(canonical)
    } catch (error) {
      throw toolError('upload_path_denied', `${canonical} cannot be read: ${error instanceof Error ? error.message : error}`)
    }
    if (!info.isFile()) throw toolError('upload_path_denied', `${canonical} is not a regular file`)
    resolved.push(canonical)
  }
  return resolved
}

/**
 * Build the audit `paramsSummary`, dropping secrets and unbounded text.
 * @param tool - tool name.
 * @param params - validated tool input.
 * @returns a JSON-safe summary.
 */
export function summarizeParams(tool, params = {}) {
  const summary = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue
    if (key === 'text' || key === 'expression' || key === 'promptText' || key === 'value') {
      summary[key] = { length: typeof value === 'string' ? value.length : String(value).length }
      continue
    }
    if (key === 'cookies') {
      const cookies = Array.isArray(value) ? value : []
      summary.cookies = {
        count: cookies.length,
        names: cookies.map((cookie) => cookie?.name).filter((name) => typeof name === 'string'),
      }
      continue
    }
    if (key === 'paths') {
      summary.paths = Array.isArray(value) ? value.map((path) => String(path)) : value
      continue
    }
    summary[key] = value
  }
  return summary
}
