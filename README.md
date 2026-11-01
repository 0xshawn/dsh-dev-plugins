# dsh-dev-plugins

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

A growing collection of plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), installed as one bundle. The current release serves the dsh Web UI through a **non-localhost authority** — a reverse proxy, SSH tunnel, or LAN address — without patching the installed dsh, and adds browser notifications, a workspace token-usage page, and a composer where Enter inserts a line break.

[中文文档](./README.zh-CN.md)

## What this fixes

Stock `dsh web` is built for a browser on the same machine. Six things are missing or break when the browser reaches it through another authority:

| Problem | Stock dsh | This plugin |
|---|---|---|
| `/api` Host/Origin fence | accepts loopback, the listener's bind literal, and `--trusted-host` only; every RPC answers `403` for a proxy authority | appends `DSH_DEV_PLUGINS_TRUSTED_HOSTS` authorities to the same list (`--trusted-host` keeps working) |
| Page view (`connection.isLoopback`) | derived from `location.hostname`; a proxied page is treated as non-loopback, so on dsh 0.2.0 settings stay in process-local memory (`settings are unavailable in this browser` on the Models page) and on every version the host-document action is hidden | injects `__DSH_TRANSPORT__ = { ownsHost: true }`, the host-owned transport hook dsh already uses for its desktop shell, so authenticated pages report the loopback view |
| Launch token | random per process; the only way to find the login URL after a restart is the service log | pins `DSH_WEB_TOKEN` (or plugin config) across restarts |
| First login | opening the bare deployment URL answers a plain `401`, so the token must come from the printed `?token=` URL | serves an HTML token form on the bare URL (`loginPage`, default on) and feeds the submitted token back into the stock exchange |
| Background attention | a finished session or a pending approval/question stays invisible while the tab is in the background | raises a Web Notification for completion and for pending input (`notifications`, default on) |
| Token usage history | the chat stats strip only shows the open Session; there is no workspace or cross-session view | adds a sidebar **Token usage** page that aggregates provider-billed tokens by workspace and day from the Host's durable session logs (`statsPage`, default on) |

Authentication is unchanged: the browser still has to exchange the launch token for the signed, authority-bound session cookie, and the Host/Origin fence still runs before every `/api` request. This plugin removes deployment friction; it does not bypass access control.

## Install

```sh
# from GitHub (public repository, no build step)
dsh plugin --profile web add git+https://github.com/0xshawn/dsh-dev-plugins.git

# from a local checkout
dsh plugin --profile web add /path/to/dsh-dev-plugins
```

Restart `dsh web` afterwards — dsh loads bundles at boot. Verify the row is active:

```sh
dsh --profile web --dump-config | grep -A6 'dsh-dev-plugins'
```

Remove with `dsh plugin --profile web remove dsh-dev-plugins`; the stock behaviour returns on the next restart.

> **Renamed in 0.5.0.** The package was `dsh-remote-access` before; the profile row and the environment variable are now `dsh-dev-plugins` and `DSH_DEV_PLUGINS_TRUSTED_HOSTS`. Remove the old row before adding this one, and rename the variable in the service environment.

### Migrating from a source patch

If a deployment currently patches the installed dsh bundles (fixed launch token plus a forced loopback classification), the switch is:

1. Stop applying the patch in the installer; `npm install -g @deepseek-ai/dsh@<version>` no longer needs a follow-up patch step.
2. Install this bundle into the `web` profile (above) and restart `dsh web`.
3. Keep the deployment's `DSH_WEB_TOKEN`; it is read by the same name. Keep `--trusted-host` or move the authorities to `DSH_DEV_PLUGINS_TRUSTED_HOSTS`.
4. Confirm the startup line still prints the pinned token: `dsh web: ...?token=<same token>`.

## Configure

### Environment

| Variable | Value | Effect |
|---|---|---|
| `DSH_DEV_PLUGINS_TRUSTED_HOSTS` | comma-separated bare authorities, e.g. `dsh.example.com,dsh.example.com:8443` | appended to `--trusted-host`; a port-less entry matches any port |
| `DSH_WEB_TOKEN` | non-empty launch token | pins the login token; empty/unset keeps the random per-process token |

Both work in systemd `Environment=`/`EnvironmentFile=`, launchd `EnvironmentVariables`, Docker env, or a shell profile. Keep `--trusted-host` if you prefer flags; the expression appends the environment authorities to the invocation list. Note that a patch layer replaces the whole `connection.config`: if another layer (or a later profile patch) overrides `connection`, restate `trustedHosts` there — otherwise the environment authorities are dropped — and restate any other key you still need, such as `cookieMaxAgeDays` or `recovery`.

```sh
DSH_WEB_TOKEN="$(cat /etc/dsh/web-token)" \
DSH_DEV_PLUGINS_TRUSTED_HOSTS="dsh.example.com" \
dsh web --host 127.0.0.1 --port 3080 --no-open
```

Malformed authorities (a scheme, path, userinfo, or zero-padded port) abort boot with the upstream validation error instead of being silently ignored.

### Plugin config

Override the `dsh-dev-plugins` row in the profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) for per-profile values:

```yaml
- id: dsh-dev-plugins
  config:
    # false keeps the stock per-authority page view.
    loopback: true
    # Fixed token; empty falls back to DSH_WEB_TOKEN, then the random token.
    # Prefer DSH_WEB_TOKEN: profile configuration is plain text.
    launchToken: ''
    # Serve a token entry form when the bare URL is opened without a token
    # or cookie. false restores the stock plain 401.
    loginPage: true
    # Enable the browser-notification client half.
    notifications: true
    # Enable the sidebar token statistics page and its read-only data route.
    statsPage: true
```

### First login without the token URL

An unauthenticated browser that opens the bare deployment URL gets a small
sign-in form instead of the plain `401`. The form submits the token back to the
relative index path (`GET ./?token=...`), so the stock token exchange, signed
cookie, proxy mount handling, and redirect to the clean URL all still apply. A
wrong token simply re-renders the form with an error; a valid token logs in.

The form is served only when the request authority already passes the
deployment's Host/Origin fence (loopback, the bind literal, or a
`DSH_DEV_PLUGINS_TRUSTED_HOSTS`/`--trusted-host` authority). An untrusted
authority keeps the plain `401`, so a DNS-rebinding or foreign host cannot
collect the token. The token still travels in the query string exactly like the
printed URL, and it remains the only credential; the form does not introduce a
second password store or a bypass. Set `loginPage: false` to restore the stock
`401` if a deployment fronting the port has its own login page.

### Behind a reverse proxy

`--public-url https://dsh.example.com/` advertises the address browsers use (printed URL, `DSH_WEB_URL`, runtime context); this plugin does not change that. The proxy must still:

- preserve the browser-facing `Host` header (the fence compares it verbatim);
- strip any mount prefix before forwarding to the listener;
- forward WebSocket upgrades with `Upgrade`/`Connection` intact;
- rewrite cookie `Path` to the mount, and add `Secure` on the HTTPS leg.

See upstream [Publish the Web UI behind a reverse proxy](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/public-deployments.md) for the full checklist. TLS termination, network isolation, and who may reach the port remain the operator's job.

### Browser notifications

The bundle also ships a browser client half (plain hand-written bundle, no build
step). It watches the Session status source and raises a Web Notification when:

- a top-level session transitions from running to idle — `Task finished: <title>`;
- the same transition carries a recent Host agent error — `Task failed: <title>`,
  with the first line of the error as the body;
- a session starts waiting for approval, plan review, or an answer —
  `Approval needed` / `Plan review needed` / `Input needed`.

Failures are read from the forwarded `api-session/error` event and paired with
the following idle transition, so a failed model call, aborted turn, or tool
loop reports the failure instead of a generic completion. Any pending
interaction registered through `uiSession` gets a notification; the current dsh
build registers approval and user questions (including plan review), and an
unknown future domain falls back to the generic `Input needed` copy.

A background Session's completion or failure notifies even while the page is
focused. The Session currently open in the page notifies only while the page is
hidden or the window is unfocused; pending-interaction notifications are not
gated by the main view. A notification is held for three seconds after a
background Session goes idle.

Tabs coordinate through local storage: a focused tab publishes the Session it
shows, other tabs suppress notifications for that Session, and one tab claims
each event so hidden tabs do not duplicate it. The client also fetches the
served boot manifest every 15 seconds and reloads itself when the plugin bundle
revision changes, so an open page cannot keep running stale notification code
after a hot update (the first release with this check still needs one manual
refresh). If a retry, queued continuation, or new pending input resumes
the session in that window, the notification is cancelled; this keeps transient
failures that immediately retry from producing an invalid notification.

Notifications appear only while the page is hidden or the window is unfocused,
and only after the browser grants notification permission. The page asks once on
the first click or keypress; grant it for the deployment origin. Clicking a
notification brings the dsh window back to the foreground. Subagent and removed
sessions are skipped, and an unknown or not-yet-listed Session is never guessed
into a notification. Set `notifications: false` in the plugin config to turn the
notification half off (the composer Enter rewrite stays active).

Limitations: this uses page Web Notifications, not Web Push. The dsh page must
stay open in a tab (it may be backgrounded); a fully closed browser receives
nothing. Permission requires a secure context, so use HTTPS or loopback, not
plain HTTP on a LAN address. Notification text includes the session title, so
lock-screen previews may expose it.

### Token usage statistics

The sidebar gains a **Token usage** entry that opens a page with:

- time presets (today, last 7 days, last 30 days, all time, custom range), with
  the day boundary taken from the browser's IANA time zone;
- a daily bar chart of provider-billed tokens;
- summary cards for the total plus uncached input, output, cache read, and
  cache write;
- a workspace table with session counts and the same four buckets.

The data comes from the Host's durable session logs, read through
`ctx.sessionQuery` without activating any Agent. The plugin replays the same
provider usage samples the stock `tokenUsage` projection folds — one settlement
per Turn/step, with retried steps counting their replacement attempt — and skips
fork-inherited event prefixes so a forked Session does not double-count its
parent's usage. Subagent Sessions are included and attributed to the workspace
of their parent chain. Sessions not registered in a workspace fall back to a
per-directory row; Sessions with no directory at all share one "Other sessions"
row.

The first request scans the complete history and may take a few seconds; later
requests reuse a per-Session fold cache that the live `session/event` feed
invalidates. The page's **Refresh** button forces a full rescan. Usage is
attributed to the local day of the event that settled the billed sample, so a
Turn crossing midnight stays on the day it settled. Set `statsPage: false` to
remove both the sidebar page and its data route.

The page reads `GET /dsh-dev-plugins/stats/data?from=<ms>&to=<ms>&tz=<IANA>`
(`from`/`to` optional, `refresh=1` forces a rescan). The route is read-only and
applies the same trusted-authority and launch-token cookie checks as `/api`; it
returns only token totals, workspace paths, and day keys, never message content.

### Composer: Enter inserts a line break

The dsh chat composer submits on Enter and inserts a line break on Shift+Enter.
This bundle flips the plain Enter key: it now inserts a line break, and a
message is sent with Cmd/Ctrl+Enter or the Send button. The rewrite targets the
composer's Lexical editor only — a plain Enter in any other input, and Enter
while a slash-command, mention, or file menu is open, keep their stock
behaviour, and IME composition is left alone. The rewrite is unconditional:
there is no plugin-config switch. While a session is running, the keyboard send
uses dsh's accelerated submit, so it does not follow the busy-Enter queue/steer
preference the Send button still honours.

## How it works

The package is a dsh **bundle**: `cordis.patch.yml` is a patch layer over `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, and several seams are used.

1. **Trusted hosts — patch layer.** The `connection` row's `trustedHosts` gets the environment list concatenated onto the invocation list. The expression reads `ctx.get('webRuntime')` (dsh 0.2.0, which already carries the bind-derived LAN literals and CLI extras) or `ctx.get('webStartup')` (dsh 0.2.1); 0.2.0 provides both services, so runtime must win to keep a wildcard bind's LAN authorities. One patch covers both layouts. The Host/Origin fence and the `allowsRemoteAuthorities` classification are then upstream's own.
2. **Loopback view — index injection.** The host plugin listens to `webserver/index-inject` and adds one inline classic script to the served index:

   ```js
   if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
   ```

   `ClientTransportHooks.ownsHost` is upstream's flag for "this page owns the Host", documented as reserved for a shell that assembles its own transport; upstream also states that served pages never carry the global. This bundle sets it deliberately to obtain owner parity: `dsh-client-connection` reports the loopback view without changing the page's HTTP + WebSocket carrier. The guard leaves any real shell-provided transport untouched, and the script runs before the shell entry and every client plugin.
3. **Launch token — service field.** The plugin waits for `ctx.connection` and sets `connection.browserAuth.launchToken` before the loader settles, so both the printed authenticated URL and token validation use the pinned value. If a future dsh version hides that field, the plugin fails loudly instead of silently printing a random URL.
4. **Login form — index authorization.** The plugin wraps `connection.authorizeIndex`, the seam `dsh-host-frontend-static` calls before serving the index. Unauthenticated GET index requests from a trusted authority get the token form (`401` with HTML); requests that are authenticated, carry a valid token, come from an untrusted authority, or use another method delegate to the stock implementation. The wrapper is restored on plugin disposal. If a future dsh version drops that method, the form is silently disabled and the stock `401` remains.

5. **Notifications — client plugin.** `package.json` declares `dsh.client` with
   `platform: web` and exports `./client`; `dsh-client-modules` serves the
   browser bundle to the page. The client subscribes to
   `ctx.uiSession.sessionStatus` through the `sessions` and `uiSession`
   services and raises local Web Notifications; `ctx.remote.$on('api-session/error')`
   supplies failure details for the next idle transition. The Host only injects
   the `__DSH_DEV_PLUGINS_NOTIFY__` feature flag from `config.notifications`.
6. **Token statistics — Host route plus client panel.** Each Session log is
   folded into provider usage settlements (`assistant/message`/`assistant/attempt`
   usage samples, replacement and retry aware) and cached per Session id. A
   `session/event` listener marks the Session dirty, so the next request rereads
   only what changed. The Host registers the exact route
   `/dsh-dev-plugins/stats/data` on `ctx.webServer` and guards it with
   `connection.isTrusted` and `connection.browserAuth.isAuthenticated`. The
   browser half registers a `main` panel and a `sidebar.panellist` entry; the
   Host injects `__DSH_DEV_PLUGINS_STATS__` from `config.statsPage`.

## Security

- **The launch token is the credential.** Anyone holding the printed `?token=` URL can obtain a session cookie and full owner access. Share it deliberately. A pinned token is a long-lived credential — never commit it. Changing `DSH_WEB_TOKEN` and restarting invalidates the old URL but does **not** revoke cookies already issued (they live for `cookieMaxAgeDays`, 30 days by default); clear the site's cookies, or remove the browser-session credential record and restart, to revoke them.
- **Trusted hosts are not authentication.** They only admit the authority to the Host/Origin fence; the signed session cookie still gates every RPC. Never expose the listener port to an untrusted network without TLS and a proxy you control.
- **Loopback parity is a privilege decision.** On dsh 0.2.0 it makes settings host-backed for authenticated remote browsers; on every version it exposes local-only UI affordances such as **Open configuration file**, which opens the settings document in the *host's* editor. Remote browsers already hold owner credentials, but operators who want the stock least-privilege view can set `loopback: false`.
- **The loopback view goes beyond a documented client contract.** Upstream documents `ownsHost` as reserved for a shell that assembles its own transport and says served pages never carry the global. This bundle sets it anyway; every current dsh consumer reads it only for `isLoopback`, but a future or third-party client plugin could treat it as proof of host ownership. `loopback: false` removes that exposure.
- **Plain HTTP leaks the token.** Terminate TLS at the proxy or with `--tls-cert/--tls-key`; the upstream guide covers cookie `Secure` behaviour.
- **The login form does not rate-limit.** It only reveals an input for the same high-entropy launch token the printed URL carries; a proxy-level rate limit is still the right control for exposed endpoints. The form never renders for an authority the Host/Origin fence rejects.
- **The statistics route exposes usage metadata.** It is authenticated with the same launch-token cookie and trusted-authority fence as `/api`, and it returns only per-workspace and per-day token totals plus workspace paths — never prompts, responses, or tool arguments. Anyone with the owner credential already has the full UI; `statsPage: false` removes the route.
- **Do not add a CSP that blocks inline scripts.** The loopback row is an inline classic script; dsh's own boot globals already require inline script permission, but a proxy-injected CSP without `'unsafe-inline'` (or a nonce covering it) silently blocks the row while the page still loads.

7. **Composer Enter — client capture listener.** The client half installs one capture-phase `keydown` listener on the page document. A plain Enter inside the composer's Lexical editor (`[data-composer-card]` containing `[data-lexical-editor="true"]`) is cancelled and replayed as the Shift+Enter chord the stock composer already maps to a line break; Cmd/Ctrl+Enter still submits. The rewrite is skipped while a slash-command, mention, or file menu (`[data-trigger-menu]`) is open, and during IME composition.

## Compatibility

- Tested against dsh `0.2.1-rc.2`, `0.2.1-rc.3`, and `0.2.0-rc.2` (Web profile).
- Declared range: `engines.dsh >=0.2.0-0 <0.3.0-0`. dsh 0.1.x is not supported or tested.
- On dsh 0.2.0 a profile-level wildcard bind (`webserver.host: 0.0.0.0`) derives LAN authorities; the patch preserves them, so the printed LAN URL works without extra trusted-host entries.
- The plugin row is Web-profile only; in a profile without a `connection` service the row stays inactive, so installing it there achieves nothing.
- `npm install -g @deepseek-ai/dsh@<version>` replaces the dsh install but not the profile: the plugin keeps working after a dsh upgrade. Restart `dsh web` to load a new dsh version.
- The token seam reads `connection.browserAuth.launchToken`. If dsh changes that shape, the plugin throws at boot when a token is configured; unset the token or update the plugin.
- The composer Enter rewrite depends on dsh-internal DOM markers (`[data-composer-card]`, `[data-lexical-editor="true"]`, `[data-trigger-menu]`). If a future dsh release renames them, the listener finds no composer and silently no-ops, restoring stock Enter-sends; it never breaks the page.
- The login form wraps `connection.authorizeIndex` and reads `browserAuth.isAuthenticated`. If a future dsh version removes either, the form is skipped and the bare URL answers the stock plain `401`; the rest of the plugin keeps working.
- Browser notifications need the client module system plus `ctx.uiSession.sessionStatus` and `ctx.sessions`; if a future dsh version drops either, the client half stays inert while the Host half keeps working. The page must stay open for notifications; there is no service worker or push subscription.
- Token statistics need `ctx.sessionQuery` (`listSessions` and `readSession`), `ctx.workspaceRegistry` (optional; an absent registry falls back to per-directory grouping), and `ctx.webServer.register`. When the session query service is missing, the data route answers `503` and the panel shows its load error.
- The pin runs once at startup. A host-plugin reload (HMR) can rebuild the Connection service from dsh's cached per-process token and will not reprint the startup URL; restart `dsh web` after changing the token or the dsh version.

## Development

```sh
npm install
npm test        # node:test unit tests for config, token resolution, index injection, usage folding, and route auth
```

End-to-end check on an isolated home (no effect on your real profile):

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile web add "$PWD"
DSH_WEB_TOKEN=dev-token DSH_DEV_PLUGINS_TRUSTED_HOSTS=dsh.test \
  dsh --profile web --host 127.0.0.1 --port 3199 --no-open
# then open http://<non-localhost>:3199/?token=dev-token through your proxy
```

## License

[MIT](./LICENSE) © 2026 shawn
