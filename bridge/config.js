/**
 * Environment configuration for the browser-control bridge.
 *
 * `parseConfig` is pure so tests can pin every default without touching the
 * filesystem or the real process environment. `loadConfig` adds the one
 * side effect the bridge needs at startup: the pairing token file.
 */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { join, resolve } from 'node:path'

/** WebSocket port used when `DSH_BROWSER_BRIDGE_PORT` is unset. */
export const DEFAULT_PORT = 8790
/** Network ring-buffer size used when `DSH_BROWSER_BRIDGE_NETWORK_LIMIT` is unset. */
export const DEFAULT_NETWORK_LIMIT = 500

function splitList(value) {
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function expandHome(value, userHome) {
  if (value === '~') return userHome
  if (value.startsWith('~/')) return join(userHome, value.slice(2))
  return value
}

function parseInteger(value, fallback, { name, min, max }) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const parsed = Number(String(value).trim())
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`browser-bridge: ${name} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

/**
 * Parse the bridge environment.
 * @param env - environment bag, normally `process.env`.
 * @param options - `home` overrides the DSH home root (`$DSH_HOME`), `homedir`
 *   overrides the user home used for `~` and the `.dsh` fallback.
 * @returns validated configuration; `token` is null when the loader has to
 *   read or create the token file.
 */
export function parseConfig(env = {}, { home, homedir } = {}) {
  const userHome = homedir ?? osHomedir()
  const dshHomeValue = (env.DSH_HOME ?? '').trim()
  const dshHome = dshHomeValue !== '' ? dshHomeValue : (home ?? join(userHome, '.dsh'))
  const bridgeHomeValue = (env.DSH_BROWSER_BRIDGE_HOME ?? '').trim()
  const bridgeHome = resolve(bridgeHomeValue !== '' ? expandHome(bridgeHomeValue, userHome) : join(dshHome, 'browser-bridge'))

  const tokenValue = (env.DSH_BROWSER_BRIDGE_TOKEN ?? '').trim()
  const uploadRootsValue = (env.DSH_BROWSER_BRIDGE_UPLOAD_ROOTS ?? '').trim()
  const downloadDirValue = (env.DSH_BROWSER_BRIDGE_DOWNLOAD_DIR ?? '').trim()

  return {
    enabled: (env.DSH_BROWSER_BRIDGE ?? '1') !== '0',
    port: parseInteger(env.DSH_BROWSER_BRIDGE_PORT, DEFAULT_PORT, {
      name: 'DSH_BROWSER_BRIDGE_PORT',
      min: 1,
      max: 65535,
    }),
    token: tokenValue !== '' ? tokenValue : null,
    home: bridgeHome,
    tokenPath: join(bridgeHome, 'token'),
    extensionIds: splitList(env.DSH_BROWSER_BRIDGE_EXTENSION_ID),
    uploadRoots:
      uploadRootsValue !== ''
        ? splitList(uploadRootsValue).map((path) => resolve(expandHome(path, userHome)))
        : [join(userHome, 'Downloads'), join(userHome, 'Desktop')],
    downloadDir: resolve(
      downloadDirValue !== '' ? expandHome(downloadDirValue, userHome) : join(userHome, 'Downloads', 'dsh-browser'),
    ),
    disabledTools: splitList(env.DSH_BROWSER_BRIDGE_DISABLE),
    networkLimit: parseInteger(env.DSH_BROWSER_BRIDGE_NETWORK_LIMIT, DEFAULT_NETWORK_LIMIT, {
      name: 'DSH_BROWSER_BRIDGE_NETWORK_LIMIT',
      min: 1,
      max: 100000,
    }),
  }
}

/**
 * Read the pairing token, generating and persisting one on first use.
 * The file is written with mode 0600 and never regenerated while it holds a
 * non-empty token, so restarts keep a previously paired extension working.
 * @param home - bridge home directory.
 * @returns the stored token.
 */
export async function readOrCreateToken(home) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700).catch(() => {})
  const tokenPath = join(home, 'token')

  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim()
    if (existing !== '') {
      await chmod(tokenPath, 0o600).catch(() => {})
      return existing
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const token = randomBytes(32).toString('hex')
  try {
    const handle = await open(tokenPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${token}\n`)
    } finally {
      await handle.close()
    }
    return token
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = (await readFile(tokenPath, 'utf8')).trim()
    if (existing !== '') return existing
    // A concurrent start won the create race and left an empty file; replace it.
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 })
    return token
  }
}

/**
 * Parse the environment and resolve the pairing token file.
 * @param env - environment bag, normally `process.env`.
 * @param options - see {@link parseConfig}.
 * @returns configuration with `token` always set when enabled.
 */
export async function loadConfig(env = process.env, options = {}) {
  const config = parseConfig(env, options)
  if (!config.enabled) return config
  if (config.token === null) config.token = await readOrCreateToken(config.home)
  return config
}
