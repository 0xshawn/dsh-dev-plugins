# Browser control: bridge and extension contract

Status: design agreed for `v0.8.0`. This note is the implementation contract for
the `bridge/` and `extension/` halves; the user-facing docs live in
`README.md` / `README.zh-CN.md`.

## Topology

```
dsh web ── stdio MCP ──▶ bridge/index.js ── WebSocket (127.0.0.1) ──▶ Chrome extension ── chrome.debugger ──▶ tabs
```

- `bridge/` is spawned by `@deepseek-ai/dsh-mcp-client` as a stdio MCP server
  (bundle patch row `mcp-browser`, `serverName: browser`). Tools surface as
  `mcp__browser__<tool>`.
- The same bridge process runs a WebSocket server on `127.0.0.1:8790`
  (configurable). Only the bundled extension connects to it.
- The extension is a thin relay: it owns `chrome.debugger`, forwards CDP
  commands, and returns results/events. All tab targeting and tool semantics
  live in the bridge.
- The extension MV3 service worker connects out (it cannot listen), reconnects
  with backoff, and keeps the socket alive with pings. Chrome 120+ required.

## Pairing and authentication

- Token: `DSH_BROWSER_BRIDGE_TOKEN` when set, otherwise the bridge generates one
  and stores it at `$DSH_BROWSER_BRIDGE_HOME/token` (default
  `$DSH_HOME/browser-bridge/token`, fallback `~/.dsh/browser-bridge/token`,
  file mode `0600`). Generated once and reused across restarts.
- The extension popup takes the token once and stores it in `chrome.storage`.
- Connection URL: `ws://127.0.0.1:<port>/extension?token=<token>`.
- The bridge compares the token in constant time and checks the `Origin` header
  (`chrome-extension://<id>`). When `DSH_BROWSER_BRIDGE_EXTENSION_ID` lists one
  or more ids, only those origins are accepted. Any failure closes with code
  `1008`.

## Wire protocol (JSON text frames)

Both directions are JSON objects with a `type` field. `protocol` is `1`.

Extension to bridge:

```json
{ "type": "hello", "protocol": 1, "extensionId": "...", "version": "0.8.0" }
{ "type": "rpc-result", "id": 7, "result": { } }
{ "type": "rpc-error", "id": 7, "error": { "code": "attach_failed", "message": "..." } }
{ "type": "event", "channel": "debugger", "payload": { "tabId": 12, "method": "Network.requestWillBeSent", "params": {} } }
{ "type": "pong", "id": 3 }
```

Bridge to extension:

```json
{ "type": "welcome", "protocol": 1, "bridgeVersion": "0.8.0" }
{ "type": "rpc", "id": 7, "method": "targets", "params": {} }
{ "type": "ping", "id": 3 }
```

Either side may send `ping`; the peer answers `pong` with the same `id`.

Bridge closes the socket when `hello` is missing within 5 s, when `protocol`
differs, or on a malformed frame.

### Extension RPC methods

| method | params | result |
|---|---|---|
| `targets` | — | `{ targets: [{ targetId, tabId, url, title, type, attached }] }`, `type: "page"` only |
| `attach` | `{ tabId }` | `{}` — `chrome.debugger.attach({ tabId }, "1.3")` |
| `detach` | `{ tabId }` | `{}` |
| `activate` | `{ tabId }` | `{}` — focus the tab |
| `create` | `{ url }` | `{ tabId, targetId }` — open an active tab |
| `close` | `{ tabId }` | `{}` |
| `cdp` | `{ tabId, method, params }` | `{ result }` — `chrome.debugger.sendCommand` |
| `status` | — | `{ attached: [{ tabId, url, title }] }` |
| `downloads` | `{ op: "list", limit? }` | `{ downloads: [{ guid, url, filename, path, state, bytesReceived, totalBytes }] }` via `chrome.downloads.search({ limit, orderBy: ["-startTime"] })`; the extension needs the `downloads` permission |

The extension manifest requests `debugger`, `tabs`, `storage`, `alarms`, and
`downloads`. `chrome.debugger.onEvent` events are forwarded as
`{ type: "event", channel: "debugger", payload: { tabId, method, params } }`.
Attach/detach changes are forwarded as
`{ type: "event", channel: "debugger", payload: { tabId, method: "attached" | "detached", params: { reason } } }`.

The bridge attaches a tab on demand (first command for that tab) and detaches
when it stops a session, closes a tab, or the tab disappears. Because the user
chose full automatic control, the bridge may select any tab; the popup only
reports state and offers Disconnect.

## Tool surface (MCP, 16 tools)

All tools return MCP `content`: one `text` block with a JSON payload and, for
screenshot-producing calls, one `image` block (`image/png`). Tool errors use
`isError: true` with a short text payload.

| tool | params | notes |
|---|---|---|
| `tabs` | `{ op: "list" \| "new" \| "select" \| "close", tabId?, url? }` | `select` activates; `new` opens an active tab |
| `navigate` | `{ url?, back?, forward?, reload?, waitUntil? }` | exactly one navigation verb; `waitUntil` `load` (default) / `domcontentloaded` / `none`; returns `{ url, title }`; a failed navigation or a missing history entry fails with `navigate_failed` |
| `observe` | `{ selector?, maxElements?, screenshot? }` | `{ url, title, text, elements: [{ ref, role, name, tag, value?, disabled?, bounds }] , refsInvalidatedAt }`; refs are stable until the next `observe`, a navigation, or selecting a different tab. `value` is omitted for password inputs |
| `screenshot` | `{ fullPage?, ref?, selector? }` | image content block only (never written to disk); element clips use the page-relative offset so scrolled pages crop correctly; device pixel ratio respected |
| `wait` | `{ selector?, text?, networkIdle?, timeoutMs? }` | first satisfied condition; default timeout 15 s |
| `click` | `{ ref?, selector?, button?, clickCount?, modifiers? }` | ref preferred; real `Input.dispatchMouseEvent` at the element box |
| `type` | `{ ref?, selector?, text, submit?, clear? }` | `clear` selects existing content first; `submit` presses Enter (form submit semantics) |
| `key` | `{ keys }` | e.g. `"Control+A"`, `"Enter"`, `"Escape"` |
| `scroll` | `{ ref?, selector?, deltaX?, deltaY?, toTop?, toBottom? }` | element or viewport |
| `dialog` | `{ accept, promptText? }` | answers the pending `Page.javascriptDialogOpening`; `{ pending: false }` when none |
| `evaluate` | `{ expression, awaitPromise?, timeoutMs? }` | main world; result JSON-serialized; default timeout 10 s; results over 1 MiB fail with `evaluate_too_large` instead of truncating |
| `network` | `{ op: "start" \| "stop" \| "list" \| "body" \| "clear", requestId? }` | ring buffer of 500 requests by default; `body` waits for the request to finish (5 s) and retries briefly while Chrome reports the body as not yet available, then returns at most 2 MB (`truncated`, `size`, `mimeType`, `base64`); nothing written to disk |
| `upload` | `{ ref?, selector?, paths: string[] }` | `~`/`~/...` expands against the user home; paths must resolve under `DSH_BROWSER_BRIDGE_UPLOAD_ROOTS` (default `~/Downloads,~/Desktop`), symlinks resolved; uses `DOM.setFileInputFiles` |
| `download` | `{ op: "url" \| "list", url?, filename? }` | `url` fetches the http(s) URL in the bridge and streams it into `DSH_BROWSER_BRIDGE_DOWNLOAD_DIR` (default `~/Downloads/dsh-browser`), returning `{ filename, path, size }` and never overwriting an existing file (collisions become `name (1).ext`); `list` reports recent Chrome downloads as `{ guid, url, filename, path, state, bytesReceived, totalBytes }`. Page-triggered downloads follow Chrome's own download setting, not this directory — Chrome refuses browser-level download routing from an extension debugger session. |
| `cookies` | `{ op: "get" \| "set" \| "clear", urls?, cookies?, name? }` | CDP `Network.getCookies` / `setCookie` / `deleteCookies`; clearing by `name` needs `urls` or uses the current tab URL, and clearing without a name wipes every cookie in the profile |
| `storage` | `{ op: "get" \| "set" \| "clear", area?, key?, value? }` | `area` `local` (default) / `session`; string values |

`evaluate`, `network`, `upload`, `download`, `cookies`, and `storage` can each be
disabled with `DSH_BROWSER_BRIDGE_DISABLE` (comma-separated tool names); a
disabled tool is not registered at all, so it is absent from `tools/list` and a
call fails with the MCP "unknown tool" error.

## Bridge configuration (environment)

| variable | default | meaning |
|---|---|---|
| `DSH_BROWSER_BRIDGE` | `1` | `0` makes the bridge exit immediately (no tools appear) |
| `DSH_BROWSER_BRIDGE_PORT` | `8790` | WebSocket port on `127.0.0.1` |
| `DSH_BROWSER_BRIDGE_TOKEN` | generated file | shared pairing token |
| `DSH_BROWSER_BRIDGE_HOME` | `$DSH_HOME/browser-bridge` or `~/.dsh/browser-bridge` | token + audit directory |
| `DSH_BROWSER_BRIDGE_EXTENSION_ID` | empty | comma-separated allowed extension ids |
| `DSH_BROWSER_BRIDGE_UPLOAD_ROOTS` | `~/Downloads,~/Desktop` | allowed upload roots |
| `DSH_BROWSER_BRIDGE_DOWNLOAD_DIR` | `~/Downloads/dsh-browser` | download destination |
| `DSH_BROWSER_BRIDGE_DISABLE` | empty | comma-separated disabled tools |
| `DSH_BROWSER_BRIDGE_NETWORK_LIMIT` | `500` | network ring-buffer size |

## Audit log

Every tool call appends one JSON line to `$DSH_BROWSER_BRIDGE_HOME/audit.jsonl`
with `{ ts, tool, paramsSummary, tabId?, url?, paths?, ok, ms, error? }`.
Secrets (tokens, cookie values, typed text) are not logged; typed text is
reduced to `{ length }`.

## Failure and reconnect behaviour

- No extension connected: tool calls fail with `bridge_disconnected` and a
  message telling the operator to open the popup and pair.
- Extension disconnects: the bridge keeps serving MCP but fails browser calls;
  the extension reconnects with exponential backoff (0.5 s → 10 s) and resends
  `hello`.
- Tab closed or debugger detached underneath: the bridge drops cached refs for
  that tab and returns `tab_unavailable`.
- Navigation failure: `navigate_failed` (CDP `errorText` or a missing
  back/forward history entry). Oversized `evaluate` results: `evaluate_too_large`.
- Tab switch during a session: the first command targeting a new tab attaches
  it, and selecting a different tab invalidates the previous tab's refs; refs
  also die when their tab navigates.
