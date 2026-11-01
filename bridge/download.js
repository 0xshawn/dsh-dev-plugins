/**
 * Bridge-side downloads for the `download` tool.
 *
 * Chrome refuses browser-level `Browser.setDownloadBehavior` from a
 * `chrome.debugger` tab session (`-32000 Cannot access browser-level
 * commands`), so the bridge fetches http(s) URLs itself and streams the body
 * into the configured directory. Download *history* still comes from the
 * extension over the `downloads` RPC.
 */
import { chmod, mkdir, open, rm } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'

import { BridgeError } from './relay.js'

/** Directory mode for the download destination. */
const DOWNLOAD_DIR_MODE = 0o700
/** File mode for downloaded files. */
const DOWNLOAD_FILE_MODE = 0o600

function toolError(code, message) {
  return new BridgeError(code, message)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function parseHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw toolError('invalid_params', 'download requires an http(s) url')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw toolError('invalid_params', `Invalid download URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw toolError('invalid_params', `download only supports http(s) URLs, got ${parsed.protocol}`)
  }
  return parsed
}

function filenameFromUrl(parsed) {
  const last = parsed.pathname.split('/').filter((part) => part !== '').pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * Pick a safe basename for the downloaded file. `filename` is optional and
 * falls back to the last URL path segment. Path separators, empty names, `.`,
 * `..`, and names containing `..` are rejected so the write cannot escape
 * `downloadDir`.
 * @param filename - requested name, or empty to derive it from the URL.
 * @param url - http(s) URL string or URL object.
 * @returns the safe file name.
 */
export function sanitizeDownloadFilename(filename, url) {
  const parsed = url instanceof URL ? url : parseHttpUrl(url)
  const candidate =
    typeof filename === 'string' && filename.trim() !== '' ? filename.trim() : filenameFromUrl(parsed)
  if (candidate === '') {
    throw toolError('invalid_params', 'Could not derive a file name from the URL; pass filename')
  }
  if (candidate === '.' || candidate === '..' || candidate.includes('..')) {
    throw toolError('invalid_params', `Unsafe download file name: ${candidate}`)
  }
  if (candidate.includes('/') || candidate.includes('\\') || candidate.includes('\0')) {
    throw toolError('invalid_params', `Unsafe download file name: ${candidate}`)
  }
  return candidate
}

/**
 * Create the target file without following symlinks or truncating an existing
 * file. `wx` fails with `EEXIST` on both an existing file and a symlink; try
 * numeric suffixes (`name (1).ext`) until an unused name is found.
 * @returns `{ handle, target, filename }`.
 */
async function openUniqueFile(directory, filename) {
  const { name, ext } = parse(filename)
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0 ? filename : `${name} (${attempt})${ext}`
    const target = join(directory, candidate)
    try {
      return { handle: await open(target, 'wx', DOWNLOAD_FILE_MODE), target, filename: candidate }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw toolError('download_unavailable', `Could not find a free file name for ${filename}`)
}

/**
 * Fetch an http(s) URL and stream it into `downloadDir`. Existing files are
 * never truncated: a numeric suffix picks a fresh name.
 * @param options - `downloadDir`, `url`, and optional `filename`.
 * @returns `{ filename, path, size }` for the saved file.
 */
export async function saveDownload({ downloadDir, url, filename } = {}) {
  if (typeof downloadDir !== 'string' || downloadDir.trim() === '') {
    throw toolError('download_unavailable', 'No download directory is configured (DSH_BROWSER_BRIDGE_DOWNLOAD_DIR)')
  }
  const parsed = parseHttpUrl(url)
  const safeName = sanitizeDownloadFilename(filename, parsed)
  const directory = resolve(downloadDir)
  await mkdir(directory, { recursive: true, mode: DOWNLOAD_DIR_MODE })
  await chmod(directory, DOWNLOAD_DIR_MODE).catch(() => {})

  let response
  try {
    response = await fetch(parsed)
  } catch (error) {
    throw toolError('download_unavailable', `The download could not be started: ${messageOf(error)}`)
  }
  if (response?.ok !== true) {
    throw toolError('download_unavailable', `The download failed with HTTP ${response?.status ?? 'unknown'}`)
  }

  let size = 0
  let handle
  let target
  let savedName = safeName
  try {
    const created = await openUniqueFile(directory, safeName)
    handle = created.handle
    target = created.target
    savedName = created.filename
    if (response.body !== null && typeof response.body?.[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        await handle.write(buffer)
        size += buffer.byteLength
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer())
      await handle.write(buffer)
      size = buffer.byteLength
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {})
      handle = undefined
    }
    if (target !== undefined) await rm(target, { force: true }).catch(() => {})
    if (error instanceof BridgeError) throw error
    throw toolError('download_unavailable', `Could not save the download: ${messageOf(error)}`)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }

  return { filename: savedName, path: target, size }
}
