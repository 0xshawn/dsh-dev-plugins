# Changelog

## 0.7.2 — 2026-11-02

Built-in bridge token: the Chrome extension needs no pairing step.

- The bridge and extension now share a fixed built-in token
  (`dsh-dev-plugins-browser-bridge-v1`), so loading the extension is enough:
  it connects to the bridge automatically once `dsh web` restarts, with no
  token file to read or paste.
- `DSH_BROWSER_BRIDGE_TOKEN` still overrides the token on the bridge side; the
  popup gained an optional **Token override** field for matching private
  deployments. The token file in `$DSH_HOME/browser-bridge` is gone.
- The listener stays loopback-only and still validates
  `Origin: chrome-extension://<id>`; `DSH_BROWSER_BRIDGE_EXTENSION_ID` can pin
  the accepted extension id.
- No change to the tools or their behaviour.

## 0.7.1 — 2026-11-02

Token statistics contrast fix.

- The time-range preset control now uses theme-defined color aliases
  (`--dsw-alias-bg-layer-2` and `--dsw-alias-interactive-bg-active`) instead of
  the undefined `--dsw-alias-fill-l1`/`--dsw-alias-fill-l2`, whose near-black
  fallbacks made the labels unreadable in the light theme.

## 0.7.0 — 2026-11-02

Browser control: a Chrome extension plus a local MCP bridge that exposes the
model's own Chrome as dsh tools.

- New `bridge/` Node process, spawned by the bundle's `mcp-browser`
  `@deepseek-ai/dsh-mcp-client` row on stdio, with a WebSocket relay on
  `127.0.0.1:8790` for the extension.
- Sixteen tools (`mcp__browser__*`): `tabs`, `navigate`, `observe`,
  `screenshot`, `wait`, `click`, `type`, `key`, `scroll`, `dialog`,
  `evaluate`, `network`, `upload`, `download`, `cookies`, `storage`.
- New hand-written MV3 extension in `extension/` (no build step; Load unpacked)
  that owns `chrome.debugger` and relays CDP commands and events. Control is
  fully automatic: the bridge attaches and switches tabs on demand.
- Pairing uses a local token file plus `Origin: chrome-extension://<id>`
  validation; every tool call is audited; uploads are limited to configured
  local roots, bridge-side URL downloads to a configured directory
  (page-triggered downloads keep Chrome's own folder), screenshots returned as
  image blocks only, and network bodies kept in memory with a 2 MB cap.
- `DSH_BROWSER_BRIDGE=0` disables the bridge and its tools;
  `DSH_BROWSER_BRIDGE_DISABLE` disables individual tools. Full knob list and
  the wire contract are in `docs/browser-control-protocol.md`.
- No change to the existing notifications, statistics, login-form, or composer
  behaviour.


## 0.6.0 — 2026-11-01

Composer Enter inserts a line break.

- A plain Enter in the dsh chat composer now inserts a line break instead of
  submitting the draft, matching Shift+Enter. Send with Cmd/Ctrl+Enter or the
  Send button.
- The rewrite runs as a capture-phase keydown listener on the page document,
  filtered to the composer's Lexical editor, and replays the Shift+Enter chord
  the stock composer already handles, so the rewritten key never submits.
- The rewrite is unconditional: there is no plugin-config switch, and
  `notifications: false` leaves it active.
- Stock behaviour is preserved for modifier chords, IME composition, inputs
  outside the composer, and an open slash-command, mention, or file menu.

## 0.5.0 — 2026-11-01

Renamed the bundle from `dsh-remote-access` to `dsh-dev-plugins`.

- The npm package, profile row id, client module id, feature-flag globals
  (`__DSH_DEV_PLUGINS_NOTIFY__`, `__DSH_DEV_PLUGINS_STATS__`), stats route
  (`/dsh-dev-plugins/stats/data`), browser storage keys, and notification tags
  (`dsh-dev-plugins:*`) are renamed.
- `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` is renamed to
  `DSH_DEV_PLUGINS_TRUSTED_HOSTS`. Update the service environment and the
  profile row (`dsh plugin --profile web remove dsh-remote-access`, then add
  this package).
- No behaviour change. Browser storage keys are renamed, so open tabs rebuild
  their cross-tab state after the reload that the bundle revision triggers. A
  notification still on screen under the old tag is left in place by the
  browser; new notifications use the new tag.
- Entries below keep the identifiers that shipped with them: a deployment
  pinned before 0.5.0 still uses `dsh-remote-access`,
  `DSH_REMOTE_ACCESS_TRUSTED_HOSTS`, `__DSH_REMOTE_ACCESS_*`, and
  `/dsh-remote-access/stats/data`. Their current spellings are used above.

## 0.4.0 — 2026-11-01

Workspace token statistics page.

- New sidebar **Token usage** page (`statsPage`, default on): a full main panel
  plus a `sidebar.panellist` entry. It aggregates provider-billed tokens across
  every live and persisted Session on the Host, including subagents, and groups
  them by workspace and local day.
- Time presets are today, last 7 days, last 30 days, all time, and a custom
  range; the day boundary uses the browser's IANA time zone. The page renders
  summary cards (total, uncached input, output, cache read, cache write), a
  daily bar chart, and a workspace table with session counts.
- The Host replays each Session log through the same provider usage samples the
  stock `tokenUsage` projection folds (replacement and retry aware) and skips
  fork-inherited prefixes. A per-Session fold cache is invalidated by
  `session/event`; the page's Refresh button forces a full rescan.
- New read-only route `GET /dsh-dev-plugins/stats/data` on `ctx.webServer`,
  guarded by the same trusted-authority and launch-token cookie checks as
  `/api`. It returns token totals, workspace paths, and day keys only.
- The first request scans the complete history and may take a few seconds;
  later requests are incremental. Sessions without a workspace registration
  fall back to a per-directory row.

## 0.3.8 — 2026-10-31

Multi-tab coordination and stale-page reload.

- A focused tab publishes its main Session in local storage; other tabs suppress
  notifications for that Session, and a per-event claim prevents hidden tabs from
  duplicating the same notification.
- Poll the served boot manifest every 15 seconds and reload the page when the
  `dsh-dev-plugins` bundle revision changes, so an open page stops running old
  notification code after a hot update. The first release with this check still
  needs one manual refresh to install it.
- Keep the per-session notification rules: background Sessions notify even when
  the page is focused; the main Session notifies only while hidden/unfocused.

## 0.3.7 — 2026-10-31

Background-session notifications while the page is focused.

- A ts-dev task completed in a background Session while the page was focused;
  the 0.3.6 page-level gate suppressed it. Completion/failure notices for
  non-main Sessions now fire even when the page is focused; the Session open in
  the page still waits for hidden/unfocused. Pending interactions are not gated.
- Subagent/unlisted filtering, the 3s settle delay, and failure details remain.

## 0.3.6 — 2026-10-31

Restore background completion notifications.

- Remove the unconditional main-view suppression from 0.3.4: it also
  suppressed a main Session's completion while the page was hidden, causing a
  real finished task to notify nothing. The existing visibility/focus gate
  still keeps active-page completions silent; pending interactions still notify.
- Subagent/unlisted filtering, the 3s settle delay, and failure details remain.

## 0.3.5 — 2026-10-30

Hardened subagent filter.

- Diagnosed a remaining subagent notification: a team subagent's client list row
  can omit `parentSessionId`, and the Session can be unlisted, so the previous
  label fallback emitted a notification named "Session".
- Check `ctx.sessions.subagentAddress` independently from the row lookup, skip
  `origin: subagent` and `depth > 0` rows, and skip unknown/unlisted Sessions
  instead of guessing a label.
- Includes the 0.3.4 main-view suppression.

## 0.3.4 — 2026-10-30

Main-session notification filter.

- Skip completion and failure notifications for the Session currently open in
  the page (its list row has `retainedBy.mainView`), because the user can already
  see that state. Pending approval/question notifications still fire.
- This removes the invalid completion notice after a user aborts the turn in the
  Session they are viewing.

## 0.3.3 — 2026-10-30

Settled-notification delay.

- Hold completion and failure notifications for three seconds after a session
  goes idle. Cancel the pending notification when a retry, queued continuation,
  or new pending interaction resumes the session, so transient failures that
  immediately retry do not produce an invalid notification.
- Pending-interaction notifications stay immediate; they are never delayed.
- Includes the 0.3.2 subagent filter (`ctx.sessions.subagentAddress`) so
  subagent completions and failures never notify.

## 0.3.2 — 2026-10-30

Subagent notification filter.

- Detect subagents with `ctx.sessions.subagentAddress()` before consulting the
  session-list row, so a subagent absent from the main list no longer raises a
  notification for its completion or failure. The row-parent check remains as a
  fallback for older service layouts.
- Subagent and removed sessions are documented as skipped; no other notification
  behavior changes.

## 0.3.1 — 2026-10-29

Failure notifications.

- Listen to the forwarded `api-session/error` event and pair it with the
  following running-to-idle transition, so a failed model call or aborted turn
  raises `Task failed: <title>` with the first line of the error instead of a
  generic completion notification.
- Stale errors (older than 15 seconds) fall back to the completion copy.
- Document the covered interactions: approval, user questions, and plan review
  are registered pending domains; any future `uiSession` pending domain gets the
  generic `Input needed` notification.

## 0.3.0 — 2026-10-28

Browser notifications.

- Add a `dsh.client` browser half (hand-written bundle, no build step) that
  raises Web Notifications when a top-level Session stops running, or when a
  session starts waiting for approval, plan review, or an answer.
- Notifications fire only while the page is hidden or unfocused and after the
  browser grants permission; the page asks once on the first click or keypress.
  Subagent and removed sessions are skipped, and clicking a notification
  focuses the dsh window.
- Add the `notifications` host config (default on) and inject
  `__DSH_DEV_PLUGINS_NOTIFY__` for the client half.
- Limitations documented: page-based Web Notifications, no Web Push, page must
  stay open, requires a secure context, and titles appear in OS notifications.

## 0.2.0 — 2026-10-27

First-login form.

- Serve a token entry form (`loginPage`, default on) when an unauthenticated
  browser opens the bare deployment URL instead of the printed `?token=` URL.
  The form posts the token back to the relative index path and reuses the stock
  token exchange, cookie, proxy-mount, and clean-URL redirect.
- Only a request authority that already passes the Host/Origin fence receives
  the form; untrusted authorities keep the plain `401`, and a rejected token
  re-renders the form with an error.
- Implemented by wrapping `connection.authorizeIndex`; the stock method is
  restored on plugin disposal, and a missing seam disables the form without
  affecting the rest of the bundle.

## 0.1.0 — 2026-10-26

Initial release.

- Bundle patch appends `DSH_DEV_PLUGINS_TRUSTED_HOSTS` authorities to the
  `/api` Host/Origin fence, keeping the invocation's `--trusted-host` values.
  One expression covers the dsh 0.2.0 `webRuntime` and 0.2.1 `webStartup`
  service layouts; `webRuntime` is preferred so a 0.2.0 wildcard bind keeps its
  bind-derived LAN authorities.
- Host plugin injects the host-owned transport hook into the served index so an
  authenticated non-loopback page reports the loopback view (`loopback`,
  default on).
- Host plugin pins the launch token from plugin config or `DSH_WEB_TOKEN`, so
  the authenticated URL survives restarts.
- Unit tests for config defaults, token resolution, index injection, and patch
  shape. Verified end to end on dsh 0.2.1-rc.2, 0.2.1-rc.3, and 0.2.0-rc.2.
