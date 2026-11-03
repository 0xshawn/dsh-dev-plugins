/**
 * dsh-dev-plugins — host half of a dsh web bundle that serves the GUI through
 * a non-localhost authority (reverse proxy, SSH tunnel, or LAN address).
 *
 * Upstream `dsh web` is built for a browser on the same machine:
 *
 *  - the `/api` Host/Origin fence trusts loopback, the listener's bind address,
 *    and every `--trusted-host` authority — never the address a proxy exposes;
 *  - the browser derives `connection.isLoopback` from `location.hostname`
 *    alone, so a page opened through a proxy keeps the non-loopback view (on
 *    dsh 0.2.0 that means process-local settings and the model page reports
 *    "settings are unavailable in this browser"; on 0.2.1 it hides the
 *    host-document action);
 *  - every dsh process mints a random launch token, so the authenticated URL
 *    in the service log changes on every restart.
 *
 * The bundle patch declares the fence authorities. This module closes the
 * other two gaps without patching the installed dsh:
 *
 *  - it injects `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` into the
 *    served index. That global is the client transport hook upstream itself
 *    sets for a shell that owns its Host (the desktop carrier); the served page
 *    then reports the loopback view while `dsh-client-connection` still uses
 *    its normal HTTP + WebSocket carrier;
 *  - it pins the launch token from plugin config or `DSH_WEB_TOKEN`.
 *
 * Neither change weakens authentication: the launch token still has to be
 * exchanged for the signed, authority-bound session cookie, and the Host /
 * Origin fence still runs before admission.
 */
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { createStatsCollector, installStatsRoute, isTrustedRequest } from './stats.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-dev-plugins'

/** The Connection service owns the launch token this plugin pins. */
export const inject = ['connection']

export const Config = z.object({
  /**
   * Inject the host-owned transport hook so every authenticated page reports
   * the loopback view. Set false to keep the stock per-authority view.
   */
  loopback: z.boolean().default(true).volatile().description(
    'Present every authenticated page as the loopback view (host-backed settings on dsh 0.2.0 and the host-document action on 0.2.1).',
  ),
  /**
   * Fixed launch token. Empty falls back to `DSH_WEB_TOKEN`, then to the
   * stock per-process random token. Prefer the environment variable: plugin
   * configuration is stored in plain text in the profile.
   */
  launchToken: z.string().default('').description(
    'Fixed launch token; empty falls back to DSH_WEB_TOKEN, then to a random per-process token.',
  ),
  /**
   * Serve a token entry form to an unauthenticated browser that opens the
   * site without the printed `?token=` URL. The form posts the token back to
   * the same index path, so the stock token exchange and cookie flow is used.
   */
  loginPage: z.boolean().default(true).volatile().description(
    'Serve a launch-token entry form for unauthenticated index requests instead of the plain 401.',
  ),
  /**
   * Enable the browser-notification client half. The page still asks for the
   * browser's notification permission once; this flag lets a deployment turn
   * the whole feature off without uninstalling the bundle.
   */
  notifications: z.boolean().default(true).volatile().description(
    'Enable browser notifications for finished sessions and pending input.',
  ),
  /**
   * Enable the sidebar token statistics page and the read-only Host route it
   * reads. The page replays the durable session logs on first use.
   */
  statsPage: z.boolean().default(true).volatile().description(
    'Enable the sidebar token statistics page and its read-only Host data route.',
  ),
  /**
   * Rewrite a plain Enter in the chat composer into the Shift+Enter line break.
   * The client half reads the host-injected `__DSH_DEV_PLUGINS_COMPOSER__`
   * switch, so a change applies after the page reloads.
   */
  composerNewline: z.boolean().default(true).volatile().description(
    'Make Enter insert a line break in the chat composer; Cmd/Ctrl+Enter still sends.',
  ),
  /**
   * Enable the browser-control MCP tools. The bridge is a child process owned
   * by the MCP client row, so a change applies after `dsh web` restarts. The
   * derived feature-state file lets the bridge read the value at boot.
   */
  browserControl: z.boolean().default(true).volatile().description(
    'Enable the browser-control MCP tools; takes effect after dsh web restarts.',
  ),
})

/**
 * Read one feature switch from plugin config. Settings-editable schema fields
 * are `volatile()`, so the Loader hands `apply` live references read with
 * `.get()`; partial plain configs (tests, older callers) still work.
 * @param config - plugin config, normally a validated {@link Config}.
 * @param key - feature switch name.
 * @param fallback - value used when the field is absent or not a boolean.
 * @returns the current boolean value of the switch.
 */
export function featureEnabled(config, key, fallback = true) {
  const value = config?.[key]
  const resolved = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  return typeof resolved === 'boolean' ? resolved : fallback
}

/**
 * Cross-instance login-page switch. A Host plugin reload can leave the previous
 * `authorizeIndex` wrapper installed; every wrapper reads this shared value, so
 * a later settings change still disables the form without nesting guards.
 */
const LOGIN_PAGE_STATE = Symbol.for('dsh-dev-plugins/login-page-state')
/** Marker and original-function slots shared across module copies. */
const LOGIN_PAGE_HANDLER = Symbol.for('dsh-dev-plugins/login-page-handler')
const LOGIN_PAGE_ORIGINAL = Symbol.for('dsh-dev-plugins/login-page-original')
const LOGIN_PAGE_REFS = Symbol.for('dsh-dev-plugins/login-page-refs')

/** Current per-process login-page state; secure selects the cookie check. */
function loginPageState() {
  return globalThis[LOGIN_PAGE_STATE] ?? { enabled: true, secure: false }
}

/** Whether the current process should serve the launch-token form. */
function loginPageEnabled() {
  return loginPageState().enabled !== false
}

/** Whether the Host serves over TLS, for the browser-auth cookie check. */
function loginPageSecure() {
  return loginPageState().secure === true
}

/**
 * Publish the transport security whenever the webServer service resolves, so a
 * wrapper installed before that service cannot keep the http default.
 * @param secure - whether the served pages use TLS.
 */
function updateLoginPageSecure(secure) {
  globalThis[LOGIN_PAGE_STATE] = { ...loginPageState(), secure: secure === true }
}

/**
 * Publish the live login-page switch for every installed wrapper.
 * @param config - plugin config.
 * @param ctx - Host context; `webServer.protocol` selects cookie security.
 * @returns the published boolean.
 */
export function syncLoginPageState(config, ctx) {
  const enabled = featureEnabled(config, 'loginPage')
  globalThis[LOGIN_PAGE_STATE] = { ...loginPageState(), enabled }
  try {
    const protocol = ctx?.get?.('webServer')?.protocol
    if (protocol !== undefined) updateLoginPageSecure(protocol === 'https:')
  } catch {
    /* a disposed context cannot resolve the webServer; keep the last value */
  }
  return enabled
}

/**
 * Resolve the dsh home directory the derived feature-state file lives under.
 * @param env - environment bag, normally `process.env`.
 * @returns `$DSH_HOME`, or `~/.dsh` when it is unset or empty.
 */
export function resolveDshHome(env = process.env) {
  const value = (env?.DSH_HOME ?? '').trim()
  return value !== '' ? value : join(homedir(), '.dsh')
}

/**
 * Path of the derived feature-state file the browser-control bridge reads at
 * startup. The plugin config stays authoritative; this file only carries the
 * switch across the process boundary.
 * @param env - environment bag, normally `process.env`.
 * @returns the absolute feature-state path.
 */
export function featureStatePath(env = process.env) {
  return join(resolveDshHome(env), 'dsh-dev-plugins', 'features.json')
}

/**
 * Persist the derived browser-control switch for the bridge.
 * @param browserControl - resolved boolean value of the switch.
 * @param env - environment bag, normally `process.env`.
 * @returns true when a file was written.
 */
export function writeFeatureState(browserControl, env = process.env) {
  if (typeof browserControl !== 'boolean') return false
  const path = featureStatePath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ browserControl })}\n`, { mode: 0o600 })
  return true
}

/**
 * Inline classic script rendered at the top of `<head>`, before the deferred
 * shell entry and every client plugin. `ownsHost` is the documented
 * `ClientTransportHooks` flag for "this page owns the Host"; the served page
 * otherwise has no `__DSH_TRANSPORT__` global, so the guard leaves any real
 * shell-provided transport untouched.
 */
const LOOPBACK_SCRIPT =
  'if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };'

/**
 * Resolve the launch token to pin.
 * @param config - validated plugin config.
 * @param env - environment bag, normally `process.env`.
 * @returns the configured token, the DSH_WEB_TOKEN value, or '' for "keep the
 * random per-process token".
 */
export function resolveLaunchToken(config, env) {
  const configured = config?.launchToken ?? ''
  if (configured !== '') return configured
  return env?.DSH_WEB_TOKEN ?? ''
}

/**
 * Build the index injection row that flips the page to the loopback view.
 * @returns a `webserver/index-inject` script row.
 */
export function loopbackIndexRow() {
  return { kind: 'script', placement: 'head', text: LOOPBACK_SCRIPT }
}

/**
 * Pin the launch token on the live Connection service. The token is a plain
 * field of the browser-auth owner; mutating it before the loader settles makes
 * both the printed authenticated URL and token validation use it.
 *
 * The pin is startup-only: upstream caches the token it minted per process, so
 * a Connection-only reload rebuilds the service from that cached value and the
 * startup URL is not reprinted. Restart `dsh web` instead of relying on
 * host-plugin HMR after changing the token.
 * @param connection - `ctx.connection` from the Host Connection service.
 * @param token - non-empty launch token.
 */
export function pinLaunchToken(connection, token) {
  const auth = connection?.browserAuth
  if (auth === null || typeof auth !== 'object' || typeof auth.launchToken !== 'string') {
    throw new Error(
      'dsh-dev-plugins: this dsh version does not expose the Connection launch token; unset launchToken/DSH_WEB_TOKEN or update the plugin',
    )
  }
  try {
    auth.launchToken = token
  } catch (error) {
    throw new Error('dsh-dev-plugins: the Connection launch token is read-only in this dsh version', {
      cause: error,
    })
  }
}

/** Compare two launch tokens without leaking length-independent timing. */
export function tokenMatches(actual, expected) {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

const LOGIN_PAGE_STYLE = `:root{color-scheme:dark;font-family:system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c10;color:#e8e8ea}
main{width:min(360px,90vw);padding:32px;border:1px solid #2a2c33;border-radius:12px;background:#14151a}
h1{font-size:18px;margin:0 0 8px}
p{margin:0 0 20px;color:#a5a7b0;font-size:13px;line-height:1.5}
p.error{color:#ff8a8a}
label{display:block;font-size:12px;margin-bottom:6px;color:#c7c9d1}
input{box-sizing:border-box;width:100%;padding:10px;border-radius:8px;border:1px solid #33353d;background:#0f1014;color:inherit;font:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#4d6bfe;color:#fff;font:inherit;font-weight:600;cursor:pointer}`

/**
 * Render the first-login token form. The form deliberately uses a relative
 * action so a proxy mount prefix is preserved: submitting from `/ui/` posts to
 * `/ui/?token=...`, which the proxy forwards as the `/` token exchange.
 * @param error - whether the request carried a token that was not accepted.
 * @returns a complete HTML document.
 */
export function loginPageHtml(error = false) {
  const message = error
    ? 'That launch token was not accepted. Try again.'
    : 'Enter the launch token printed by the dsh web service.'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DeepSeek Harness — sign in</title>
<style>${LOGIN_PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>DeepSeek Harness</h1>
<p${error ? ' class="error"' : ''}>${message}</p>
<form method="get" action=".">
<label for="token">Launch token</label>
<input id="token" name="token" type="password" autocomplete="off" spellcheck="false" required autofocus>
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>
`
}

function writeLoginPage(response, error) {
  response.writeHead(401, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })
  response.end(loginPageHtml(error))
}

/**
 * Serve the token form for unauthenticated GET index requests, using the
 * existing Connection token exchange for the actual sign-in. Requests that are
 * authenticated, carry a valid token, come from an untrusted authority, or are
 * not GET requests keep the stock behavior.
 * @param ctx - Host context; `webServer.protocol` selects cookie security.
 * @param connection - the Host Connection service.
 * @param config - plugin config; the live `loginPage` switch disables the form.
 * @returns true when the form was installed.
 */
export function installLoginPage(ctx, connection, config) {
  syncLoginPageState(config, ctx)
  if (typeof connection?.authorizeIndex !== 'function') return false
  const auth = connection.browserAuth
  if (
    auth === null ||
    typeof auth !== 'object' ||
    typeof auth.isAuthenticated !== 'function' ||
    typeof auth.launchToken !== 'string'
  ) {
    return false
  }
  let handler = connection.authorizeIndex
  if (handler?.[LOGIN_PAGE_HANDLER] !== true) {
    const original = connection.authorizeIndex
    const authorize = original.bind(connection)
    handler = (request, response) => {
      if (request.method !== 'GET') return authorize(request, response)
      if (!loginPageEnabled()) return authorize(request, response)
      let url
      try {
        url = new URL(request.url ?? '/', 'http://dsh.invalid')
      } catch {
        return authorize(request, response)
      }
      if (auth.isAuthenticated(request, loginPageSecure())) return authorize(request, response)
      if (!isTrustedRequest(connection, request)) return authorize(request, response)
      const tokens = url.searchParams.getAll('token')
      if (tokens.length === 1 && tokenMatches(tokens[0] ?? '', auth.launchToken)) {
        if (url.pathname === '/') return authorize(request, response)
        // Upstream exchanges the token only at the site root; send a mounted
        // index request to the directory root so the exchange can run.
        response.writeHead(303, {
          'cache-control': 'no-store',
          location: `./?token=${encodeURIComponent(tokens[0] ?? '')}`,
          'referrer-policy': 'no-referrer',
        })
        response.end()
        return false
      }
      writeLoginPage(response, tokens.length > 0)
      return false
    }
    handler[LOGIN_PAGE_HANDLER] = true
    handler[LOGIN_PAGE_ORIGINAL] = original
  }
  ctx.effect(() => {
    handler[LOGIN_PAGE_REFS] = (handler[LOGIN_PAGE_REFS] ?? 0) + 1
    connection.authorizeIndex = handler
    return () => {
      const refs = Math.max(0, (handler[LOGIN_PAGE_REFS] ?? 1) - 1)
      handler[LOGIN_PAGE_REFS] = refs
      if (refs === 0 && connection.authorizeIndex === handler) {
        connection.authorizeIndex = handler[LOGIN_PAGE_ORIGINAL]
      }
    }
  }, 'dsh-dev-plugins: login page')
  return true
}

/**
 * Mount the plugin contributions.
 * @param ctx - Host Cordis context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const launchToken = resolveLaunchToken(config, process.env)
  /** Keep the derived bridge state in sync with live setting edits. */
  const syncFeatureState = () => {
    try {
      writeFeatureState(featureEnabled(config, 'browserControl'))
    } catch (error) {
      ctx.logger?.warn?.('dsh-dev-plugins: could not write the browser-control feature state:', error)
    }
  }
  ctx.on('webserver/index-inject', (table) => {
    if (featureEnabled(config, 'loopback')) table.push(loopbackIndexRow())
    table.push({
      kind: 'global',
      name: '__DSH_DEV_PLUGINS_NOTIFY__',
      value: { enabled: featureEnabled(config, 'notifications') },
    })
    table.push({
      kind: 'global',
      name: '__DSH_DEV_PLUGINS_STATS__',
      value: { enabled: featureEnabled(config, 'statsPage') },
    })
    table.push({
      kind: 'global',
      name: '__DSH_DEV_PLUGINS_COMPOSER__',
      value: { enabled: featureEnabled(config, 'composerNewline') },
    })
  })
  ctx.on('loader/volatile-update', () => {
    syncFeatureState()
    syncLoginPageState(config, ctx)
  })
  syncFeatureState()
  if (launchToken !== '') {
    pinLaunchToken(ctx.get('connection'), launchToken)
  }
  installLoginPage(ctx, ctx.get('connection'), config)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const webServer = webCtx?.get?.('webServer') ?? webCtx?.webServer
        updateLoginPageSecure(webServer?.protocol === 'https:')
      } catch {
        /* keep the value captured at install time */
      }
    })
  }
  installStatsRoute(ctx, createStatsCollector(ctx), config, () => featureEnabled(config, 'statsPage'))
  // The bundle owns a custom settings page, so suppress the generic
  // auto-generated page the settings domain would otherwise offer.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.effect?.(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'dsh-dev-plugins: settings page policy')
    })
  }
}
