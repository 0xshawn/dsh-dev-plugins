# Changelog

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
- New read-only route `GET /dsh-remote-access/stats/data` on `ctx.webServer`,
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
  `dsh-remote-access` bundle revision changes, so an open page stops running old
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
  `__DSH_REMOTE_ACCESS_NOTIFY__` for the client half.
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

- Bundle patch appends `DSH_REMOTE_ACCESS_TRUSTED_HOSTS` authorities to the
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
