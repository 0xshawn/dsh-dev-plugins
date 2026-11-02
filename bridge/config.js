/**
 * Environment configuration for the browser-control bridge.
 *
 * `parseConfig` is pure so tests can pin every default without touching the
 * filesystem or the real process environment. The pairing token is a fixed
 * built-in value so the extension can connect without a manual pairing step;
 * `DSH_BROWSER_BRIDGE_TOKEN` overrides it for deployments that want a secret
 * shared only through their own configuration.
 */
import { readFile } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { join, resolve } from 'node:path'

/** WebSocket port used when `DSH_BROWSER_BRIDGE_PORT` is unset. */
export const DEFAULT_PORT = 8790
/**
 * Fixed pairing token shared with the extension when no environment override
 * is configured. It is a convenience default, not a secret: the listener binds
 * loopback only, and `DSH_BROWSER_BRIDGE_EXTENSION_ID` can restrict which
 * extension origin is accepted.
 */
export const BRIDGE_DEFAULT_TOKEN = 'dsh-dev-plugins-browser-bridge-v1'
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
 * @returns validated configuration; `token` is always a non-empty string.
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
    token: tokenValue !== '' ? tokenValue : BRIDGE_DEFAULT_TOKEN,
    home: bridgeHome,
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
 * Read the derived feature-state file the Host plugin writes.
 *
 * The plugin config stays authoritative; this file only carries the
 * `browserControl` switch across the process boundary, because the MCP client
 * spawns the bridge at boot and cannot reconfigure a running child. The
 * settings page rewrites the file as soon as the switch changes; hand-editing
 * the profile config while dsh web is stopped can race this boot-time read, so
 * prefer the settings page for that switch.
 * @param env - environment bag, normally `process.env`.
 * @param options - `home` overrides the DSH home root (`$DSH_HOME`), `homedir`
 *   overrides the user home used for the `.dsh` fallback.
 * @returns the parsed state, or an empty object when the file is missing or
 *   malformed.
 */
export async function readFeatureState(env = {}, { home, homedir } = {}) {
  const userHome = homedir ?? osHomedir()
  const dshHomeValue = (env.DSH_HOME ?? "").trim()
  const dshHome = dshHomeValue !== "" ? dshHomeValue : (home ?? join(userHome, ".dsh"))
  try {
    const state = JSON.parse(await readFile(join(dshHome, "dsh-dev-plugins", "features.json"), "utf8"))
    return state !== null && typeof state === "object" ? state : {}
  } catch {
    return {}
  }
}

/**
 * Parse the bridge environment and apply the plugin-settings feature state.
 * @param env - environment bag, normally `process.env`.
 * @param options - see {@link parseConfig}.
 * @returns configuration with the fixed or overridden token, disabled when the
 *   settings page turned browser control off.
 */
export async function loadConfig(env = process.env, options = {}) {
  const config = parseConfig(env, options)
  if (!config.enabled) return config
  const features = await readFeatureState(env, options)
  if (features.browserControl === false) config.enabled = false
  return config
}
