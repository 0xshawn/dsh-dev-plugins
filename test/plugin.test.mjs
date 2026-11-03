import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  apply,
  Config,
  featureEnabled,
  featureStatePath,
  inject,
  installLoginPage,
  loginPageHtml,
  loopbackIndexRow,
  name,
  pinLaunchToken,
  resolveDshHome,
  resolveLaunchToken,
  tokenMatches,
  writeFeatureState,
} from '../lib/index.js'

/** Read the six settings-editable switches out of a resolved config. */
function featureFlags(config) {
  const flags = {}
  for (const key of ['loopback', 'loginPage', 'notifications', 'statsPage', 'composerNewline', 'browserControl']) {
    flags[key] = featureEnabled(config, key)
  }
  return flags
}

/** Every apply() writes the derived bridge state; keep it inside a temp home. */
let testHome
let previousDshHome
before(async () => {
  previousDshHome = process.env.DSH_HOME
  testHome = await mkdtemp(join(tmpdir(), 'dsh-dev-plugins-tests-'))
  process.env.DSH_HOME = testHome
})
after(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(testHome, { recursive: true, force: true })
})

/** Minimal Cordis context: one event emitter plus a `get` service lookup. */
function fakeContext(connection) {
  const listeners = new Map()
  return {
    get: (service) => (service === 'connection' ? connection : undefined),
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

function fakeConnection() {
  return { browserAuth: { launchToken: 'random-process-token' } }
}

test('plugin metadata follows the Cordis plugin shape', () => {
  assert.equal(name, 'dsh-dev-plugins')
  assert.deepEqual(inject, ['connection'])
})

test('Config defaults keep the patch behaviour', () => {
  const defaults = Config({})
  // Settings pages are served only for volatile fields: the Host filters the
  // entry out of the describe form otherwise, so pin the editable shape here.
  for (const key of ['loopback', 'loginPage', 'notifications', 'statsPage', 'composerNewline', 'browserControl']) {
    assert.equal(typeof defaults[key]?.get, 'function', `${key} must be volatile`)
  }
  assert.equal(typeof defaults.launchToken, 'string', 'launchToken stays out of the settings form')
  assert.deepEqual(featureFlags(defaults), {
    loopback: true,
    loginPage: true,
    notifications: true,
    statsPage: true,
    composerNewline: true,
    browserControl: true,
  })
  assert.equal(Config({}).launchToken, '')
  assert.deepEqual(
    featureFlags(
      Config({
        loopback: false,
        launchToken: 'fixed',
        loginPage: false,
        notifications: false,
        statsPage: false,
        composerNewline: false,
        browserControl: false,
      }),
    ),
    {
      loopback: false,
      loginPage: false,
      notifications: false,
      statsPage: false,
      composerNewline: false,
      browserControl: false,
    },
  )
  assert.equal(
    Config({
      launchToken: 'fixed',
    }).launchToken,
    'fixed',
  )
  assert.deepEqual(featureFlags(Config({ notifications: false, statsPage: false })), {
    loopback: true,
    loginPage: true,
    notifications: false,
    statsPage: false,
    composerNewline: true,
    browserControl: true,
  })
  assert.throws(() => Config({ loopback: 'yes' }), /expected boolean/u)
})

test('feature state resolves the dsh home and writes the browser-control switch', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-dev-plugins-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  assert.equal(resolveDshHome({ DSH_HOME: home }), home)
  assert.equal(featureStatePath({ DSH_HOME: home }), join(home, 'dsh-dev-plugins', 'features.json'))
  assert.equal(writeFeatureState(undefined, { DSH_HOME: home }), false)
  assert.equal(writeFeatureState(false, { DSH_HOME: home }), true)
  assert.deepEqual(JSON.parse(await readFile(join(home, 'dsh-dev-plugins', 'features.json'), 'utf8')), {
    browserControl: false,
  })
})

test('resolveLaunchToken prefers config, then DSH_WEB_TOKEN, then the random token', () => {
  assert.equal(resolveLaunchToken({ launchToken: 'from-config' }, { DSH_WEB_TOKEN: 'from-env' }), 'from-config')
  assert.equal(resolveLaunchToken({ launchToken: '' }, { DSH_WEB_TOKEN: 'from-env' }), 'from-env')
  assert.equal(resolveLaunchToken({ launchToken: '' }, {}), '')
  assert.equal(resolveLaunchToken(undefined, undefined), '')
})

test('loopbackIndexRow uses the client transport hook with a guard', () => {
  const row = loopbackIndexRow()
  assert.equal(row.kind, 'script')
  assert.equal(row.placement, 'head')
  assert.match(row.text, /__DSH_TRANSPORT__ === void 0/u)
  assert.match(row.text, /ownsHost: true/u)
})

test('apply injects one loopback row into the served index', () => {
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { loopback: true, launchToken: '' })
  assert.equal(ctx.listenerCount('webserver/index-inject'), 1)
  const table = []
  ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  assert.deepEqual(table, [
    loopbackIndexRow(),
    { kind: 'global', name: '__DSH_DEV_PLUGINS_NOTIFY__', value: { enabled: true } },
    { kind: 'global', name: '__DSH_DEV_PLUGINS_STATS__', value: { enabled: true } },
    { kind: 'global', name: '__DSH_DEV_PLUGINS_COMPOSER__', value: { enabled: true } },
  ])
})

test('apply persists the browser-control switch for the bridge to read at boot', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-dev-plugins-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { loopback: true, launchToken: '', browserControl: false })
  const table = []
  ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  assert.deepEqual(
    table.filter((row) => row.kind === 'global').map((row) => row.name),
    ['__DSH_DEV_PLUGINS_NOTIFY__', '__DSH_DEV_PLUGINS_STATS__', '__DSH_DEV_PLUGINS_COMPOSER__'],
  )
  assert.deepEqual(JSON.parse(await readFile(join(home, 'dsh-dev-plugins', 'features.json'), 'utf8')), {
    browserControl: false,
  })
  assert.equal(ctx.listenerCount('loader/volatile-update'), 1)
})

test('a volatile settings edit refreshes the derived feature state and page globals', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-dev-plugins-live-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  const live = { browserControl: true, composerNewline: true, loopback: true, notifications: true, statsPage: true, loginPage: true }
  const config = Object.fromEntries(Object.keys(live).map((key) => [key, { get: () => live[key] }]))
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { ...config, launchToken: '' })
  live.browserControl = false
  live.composerNewline = false
  ctx.emit('loader/volatile-update', [['browserControl']])
  assert.deepEqual(JSON.parse(await readFile(join(home, 'dsh-dev-plugins', 'features.json'), 'utf8')), {
    browserControl: false,
  })
  const table = []
  ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  const composer = table.find((row) => row.name === '__DSH_DEV_PLUGINS_COMPOSER__')
  assert.deepEqual(composer?.value, { enabled: false })
})

test('apply with loopback=false leaves the page authority alone but keeps configuration', () => {
  const ctx = fakeContext(fakeConnection())
  apply(ctx, { loopback: false, launchToken: '' })
  const table = []
  ctx.emit('webserver/index-inject', table, { principal: { kind: 'owner' } })
  assert.deepEqual(table, [
    { kind: 'global', name: '__DSH_DEV_PLUGINS_NOTIFY__', value: { enabled: true } },
    { kind: 'global', name: '__DSH_DEV_PLUGINS_STATS__', value: { enabled: true } },
    { kind: 'global', name: '__DSH_DEV_PLUGINS_COMPOSER__', value: { enabled: true } },
  ])
})

test('apply does not touch the launch token when none is configured', () => {
  const connection = fakeConnection()
  apply(fakeContext(connection), { loopback: false, launchToken: '' })
  assert.equal(connection.browserAuth.launchToken, 'random-process-token')
})

test('apply pins the configured launch token', () => {
  const connection = fakeConnection()
  apply(fakeContext(connection), { loopback: false, launchToken: 'pinned-token' })
  assert.equal(connection.browserAuth.launchToken, 'pinned-token')
})

test('apply falls back to DSH_WEB_TOKEN', () => {
  const previous = process.env.DSH_WEB_TOKEN
  process.env.DSH_WEB_TOKEN = 'env-token'
  try {
    const connection = fakeConnection()
    apply(fakeContext(connection), { loopback: false, launchToken: '' })
    assert.equal(connection.browserAuth.launchToken, 'env-token')
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_TOKEN
    else process.env.DSH_WEB_TOKEN = previous
  }
})

test('pinLaunchToken fails loudly on an unsupported dsh version', () => {
  assert.throws(() => pinLaunchToken(undefined, 'token'), /does not expose the Connection launch token/u)
  assert.throws(() => pinLaunchToken({}, 'token'), /does not expose the Connection launch token/u)
  assert.throws(
    () => pinLaunchToken({ browserAuth: { launchToken: 42 } }, 'token'),
    /does not expose the Connection launch token/u,
  )
})

test('pinLaunchToken surfaces a read-only token field', () => {
  const connection = {
    browserAuth: Object.freeze({ launchToken: 'random-process-token' }),
  }
  assert.throws(() => pinLaunchToken(connection, 'token'), /read-only in this dsh version/u)
})

test('bundle patch declares deployment authorities for the /api fence', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: connection/u)
  assert.match(patch, /DSH_DEV_PLUGINS_TRUSTED_HOSTS/u)
  assert.match(patch, /ctx\.get\('webStartup'\)/u)
  assert.match(patch, /ctx\.get\('webRuntime'\)/u)
  assert.match(patch, /name: dsh-dev-plugins/u)
})

/** Read the `trustedHosts` expression from the shipped bundle patch. */
async function patchTrustedHostsExpression() {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const match = /trustedHosts: !!js "(?<expression>.+)"/u.exec(patch)
  assert.ok(match?.groups?.expression, 'trustedHosts expression missing from cordis.patch.yml')
  return match.groups.expression
}

/** Evaluate the patch expression the loader would evaluate. */
function evaluatePatch(expression, services, env) {
  const ctx = { get: (name) => services[name] }
  return new Function('ctx', 'process', `return (${expression})`)(ctx, { env })
}

test('bundle patch keeps 0.2.0 bind-derived LAN authorities when both services exist', async () => {
  const expression = await patchTrustedHostsExpression()
  const startup = { trustedHosts: ['cli.example.test'] }
  const runtime = { trustedHosts: ['192.168.1.202', 'cli.example.test'] }

  // dsh 0.2.0 provides webStartup AND webRuntime; webRuntime carries the LAN
  // literals the wildcard bind derived and already includes the CLI extras.
  assert.deepEqual(evaluatePatch(expression, { webStartup: startup, webRuntime: runtime }, {}), [
    '192.168.1.202',
    'cli.example.test',
  ])
})

test('bundle patch keeps 0.2.1 invocation authorities', async () => {
  const expression = await patchTrustedHostsExpression()
  const startup = { trustedHosts: ['cli.example.test'] }
  assert.deepEqual(evaluatePatch(expression, { webStartup: startup }, {}), ['cli.example.test'])
})

test('bundle patch appends trimmed environment authorities and ignores empties', async () => {
  const expression = await patchTrustedHostsExpression()
  assert.deepEqual(
    evaluatePatch(expression, {}, {
      DSH_DEV_PLUGINS_TRUSTED_HOSTS: ' env.example.test , env2.example.test:8443 , ',
    }),
    ['env.example.test', 'env2.example.test:8443'],
  )
  assert.deepEqual(evaluatePatch(expression, {}, { DSH_DEV_PLUGINS_TRUSTED_HOSTS: '' }), [])
})


function fakeResponse() {
  const response = { status: undefined, headers: undefined, body: undefined, ended: false }
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers
  }
  response.end = (body) => {
    response.body = body
    response.ended = true
  }
  return response
}

function loginFixture(options = {}) {
  const originalCalls = []
  const connection = {
    browserAuth: {
      launchToken: options.launchToken ?? 'correct-token',
      isAuthenticated: () => options.authenticated ?? false,
    },
    isTrusted: () => options.trusted ?? true,
    authorizeIndex: (request, response) => {
      originalCalls.push({ request, response })
      response.original = true
      return true
    },
  }
  const disposers = []
  const ctx = {
    get: (service) => (service === 'webServer' ? { protocol: options.protocol ?? 'http:' } : undefined),
    effect: (callback) => {
      disposers.push(callback())
    },
  }
  const installed = installLoginPage(ctx, connection, {
    loginPage: options.loginPage ?? true,
  })
  return { connection, ctx, disposers, installed, originalCalls }
}

function fakeRequest(url = '/', method = 'GET') {
  return { url, method, headers: {} }
}

test('tokenMatches compares exact tokens', () => {
  assert.equal(tokenMatches('abc', 'abc'), true)
  assert.equal(tokenMatches('abc', 'abd'), false)
  assert.equal(tokenMatches('abc', 'abcd'), false)
  assert.equal(tokenMatches('', ''), true)
})

test('loginPageHtml renders the token form and error state', () => {
  const form = loginPageHtml(false)
  assert.match(form, /<form method="get" action="\.">/u)
  assert.match(form, /name="token"/u)
  assert.match(form, /type="password"/u)
  assert.doesNotMatch(form, /not accepted/u)
  assert.match(loginPageHtml(true), /not accepted/u)
})

test('login page serves a 401 form to unauthenticated browsers', () => {
  const fixture = loginFixture()
  assert.equal(fixture.installed, true)
  const response = fakeResponse()
  const result = fixture.connection.authorizeIndex(fakeRequest('/'), response)
  assert.equal(result, false)
  assert.equal(fixture.originalCalls.length, 0)
  assert.equal(response.status, 401)
  assert.match(response.headers['content-type'], /text\/html/u)
  assert.match(response.headers['content-security-policy'], /form-action 'self'/u)
  assert.match(response.body, /Enter the launch token/u)
})

test('login page reports a rejected token', () => {
  const fixture = loginFixture()
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/?token=wrong'), response)
  assert.equal(response.status, 401)
  assert.match(response.body, /not accepted/u)
})

test('an authenticated browser keeps the stock index path', () => {
  const fixture = loginFixture({ authenticated: true })
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/'), response)
  assert.equal(fixture.originalCalls.length, 1)
  assert.equal(response.body, undefined)
})

test('a valid token keeps the stock token exchange', () => {
  const fixture = loginFixture()
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/?token=correct-token'), response)
  assert.equal(fixture.originalCalls.length, 1)
})

test('a valid token on a mounted index request redirects to the directory root', () => {
  const fixture = loginFixture()
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/index.html?token=correct-token'), response)
  assert.equal(fixture.originalCalls.length, 0)
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, './?token=correct-token')
})

test('an untrusted authority keeps the stock behavior', () => {
  const fixture = loginFixture({ trusted: false })
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/'), response)
  assert.equal(fixture.originalCalls.length, 1)
  assert.equal(response.status, undefined)
})

test('non-GET requests keep the stock behavior', () => {
  const fixture = loginFixture()
  const response = fakeResponse()
  fixture.connection.authorizeIndex(fakeRequest('/', 'HEAD'), response)
  assert.equal(fixture.originalCalls.length, 1)
})

test('a re-applied login config updates already installed wrappers', () => {
  const fixture = loginFixture()
  assert.equal(fixture.installed, true)
  try {
    const first = fakeResponse()
    fixture.connection.authorizeIndex(fakeRequest('/'), first)
    assert.equal(first.status, 401)
    assert.equal(fixture.originalCalls.length, 0)
    installLoginPage(fixture.ctx, fixture.connection, { loginPage: false })
    const second = fakeResponse()
    fixture.connection.authorizeIndex(fakeRequest('/'), second)
    assert.equal(fixture.originalCalls.length, 1)
    assert.equal(second.status, undefined)
  } finally {
    delete globalThis[Symbol.for('dsh-dev-plugins/login-page-state')]
  }
})

test('a volatile login config updates the installed wrapper without stacking', () => {
  const fixture = loginFixture()
  const installed = fixture.connection.authorizeIndex
  try {
    const live = { loginPage: true }
    const config = { loginPage: { get: () => live.loginPage } }
    installLoginPage(fixture.ctx, fixture.connection, config)
    assert.equal(fixture.connection.authorizeIndex, installed)
    live.loginPage = false
    installLoginPage(fixture.ctx, fixture.connection, config)
    assert.equal(fixture.connection.authorizeIndex, installed)
    fixture.connection.authorizeIndex(fakeRequest('/'), fakeResponse())
    assert.equal(fixture.originalCalls.length, 1)
  } finally {
    delete globalThis[Symbol.for('dsh-dev-plugins/login-page-state')]
  }
})

test('the login wrapper restores the stock handler after the last disposal', () => {
  const fixture = loginFixture()
  const wrapper = fixture.connection.authorizeIndex
  const stock = wrapper[Symbol.for('dsh-dev-plugins/login-page-original')]
  try {
    installLoginPage(fixture.ctx, fixture.connection, { loginPage: true })
    assert.equal(fixture.disposers.length, 2)
    fixture.disposers[0]()
    assert.equal(fixture.connection.authorizeIndex, wrapper)
    fixture.disposers[1]()
    assert.equal(fixture.connection.authorizeIndex, stock)
  } finally {
    delete globalThis[Symbol.for('dsh-dev-plugins/login-page-state')]
  }
})

test('loginPage: false delegates to the stock authorizeIndex', () => {
  const fixture = loginFixture({ loginPage: false })
  assert.equal(fixture.installed, true)
  assert.notEqual(fixture.connection.authorizeIndex.name, 'authorizeIndex')
  fixture.connection.authorizeIndex(fakeRequest('/'), fakeResponse())
  assert.equal(fixture.originalCalls.length, 1)
})

test('a volatile config update refreshes the live login switch', () => {
  const live = { loginPage: true }
  const config = {
    launchToken: '',
    loginPage: { get: () => live.loginPage },
    loopback: { get: () => true },
    notifications: { get: () => true },
    statsPage: { get: () => true },
    composerNewline: { get: () => true },
    browserControl: { get: () => true },
  }
  let calls = 0
  const connection = {
    browserAuth: { launchToken: 'token', isAuthenticated: () => false },
    isTrusted: () => true,
    authorizeIndex: () => {
      calls += 1
    },
  }
  const ctx = fakeContext(connection)
  ctx.effect = (callback) => callback()
  try {
    apply(ctx, config)
    assert.notEqual(connection.authorizeIndex.name, 'authorizeIndex')
    live.loginPage = false
    ctx.emit('loader/volatile-update', [])
    connection.authorizeIndex(fakeRequest('/'), fakeResponse())
    assert.equal(calls, 1)
  } finally {
    delete globalThis[Symbol.for('dsh-dev-plugins/login-page-state')]
  }
})

test('plugin disposal restores the stock authorizeIndex', () => {
  const fixture = loginFixture()
  const installed = fixture.connection.authorizeIndex
  assert.equal(fixture.installed, true)
  fixture.disposers[0]()
  assert.notEqual(fixture.connection.authorizeIndex, installed)
  assert.equal(fixture.connection.authorizeIndex.name, 'authorizeIndex')
})

test('login page is skipped on a Connection service without browser auth', () => {
  const ctx = { get: () => undefined, effect: () => {} }
  assert.equal(installLoginPage(ctx, {}, { loginPage: true }), false)
})
