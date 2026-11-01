window.__ModuleLoader__.load({
  id: 'dsh-dev-plugins',
  factory: (require) => {
    var module = { exports: {} };

    /** Stable client plugin name. */
    const name = 'dsh-dev-plugins-notifications'
    /** Session list supplies titles; uiSession supplies the live status facts. */
    const inject = ['remote', 'sessions', 'uiSession']
    /** Host-injected feature switch. */
    const CONFIG_GLOBAL = '__DSH_DEV_PLUGINS_NOTIFY__'
    /** Host-injected token-statistics switch. */
    const STATS_CONFIG_GLOBAL = '__DSH_DEV_PLUGINS_STATS__'
    /** Locale namespace and sidebar identity of the statistics panel. */
    const STATS_NS = 'dsh-dev-plugins.stats'
    const STATS_PANEL_ID = 'token-stats'
    /** Relative data route; resolved against the served page base. */
    const STATS_DATA_PATH = 'dsh-dev-plugins/stats/data'
    const DAY_MS = 86400000
    /** Notifications kept alive until the browser closes them. */
    const live = new Set()
    /** How long a Host agent error is paired with the following idle transition. */
    const ERROR_WINDOW_MS = 15000
    /** Wait for an idle session to stay idle before notifying; retries/continuations resume. */
    const SETTLE_MS = 3000
    /** Cross-tab coordination: which visible tab is viewing which Session. */
    const VIEW_KEY = 'dsh-dev-plugins:viewing'
    const CLAIM_PREFIX = 'dsh-dev-plugins:claim:'
    const PEER_TTL_MS = 6000
    const CLAIM_TTL_MS = 5000
    /** Detect a stale browser bundle and reload the page after a hot update. */
    const UPDATE_POLL_MS = 15000
    const RELOAD_GUARD_KEY = 'dsh-dev-plugins:reload-rev'
    const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

    /** Whether the deployment enabled the client half. */
    function enabled() {
      const config = globalThis[CONFIG_GLOBAL]
      return !(config !== null && typeof config === 'object' && config.enabled === false)
    }

    /** Whether the deployment enabled the token statistics panel. */
    function statsEnabled() {
      const config = globalThis[STATS_CONFIG_GLOBAL]
      return !(config !== null && typeof config === 'object' && config.enabled === false)
    }

    /** Compact token count: 517 / 12.2K / 3.4M / 1.2B. */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0'
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`
      return String(Math.round(value))
    }

    /** Local calendar day start for one epoch millisecond value. */
    function startOfLocalDay(time) {
      const date = new Date(time)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    /** Local calendar day end for one epoch millisecond value. */
    function endOfLocalDay(time) {
      const date = new Date(time)
      date.setHours(23, 59, 59, 999)
      return date.getTime()
    }

    /** `YYYY-MM-DD` value for a `<input type="date">` in local time. */
    function localDateInputValue(time) {
      const date = new Date(time)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** Parse one local `YYYY-MM-DD` date input, or undefined when invalid. */
    function parseDateInput(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day)
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
      return date.getTime()
    }

    /** Inclusive epoch range for one preset, or a custom pair. */
    function rangeForPreset(preset, now = Date.now(), customFrom, customTo) {
      if (preset === 'all') return { from: null, to: null }
      if (preset === 'custom') {
        const from = parseDateInput(customFrom)
        const to = parseDateInput(customTo)
        if (from === undefined || to === undefined) return { from: null, to: null }
        return { from: startOfLocalDay(from), to: endOfLocalDay(to) }
      }
      const days = preset === 'today' ? 1 : preset === '30d' ? 30 : 7
      return { from: startOfLocalDay(now) - (days - 1) * DAY_MS, to: now }
    }

    /** Build the statistics data URL from a page base URL. */
    function statsDataUrl(baseUrl, { from, to, timeZone, refresh } = {}) {
      const url = new URL(STATS_DATA_PATH, baseUrl)
      if (typeof from === 'number') url.searchParams.set('from', String(from))
      if (typeof to === 'number') url.searchParams.set('to', String(to))
      if (typeof timeZone === 'string' && timeZone !== '') url.searchParams.set('tz', timeZone)
      if (refresh === true) url.searchParams.set('refresh', '1')
      return url
    }

    /** Token statistics copy. */
    const STATS_EN = {
      panel: 'Token usage',
      title: 'Token usage',
      description: 'Provider-billed tokens across every workspace and session on this Host, including subagents.',
      refresh: 'Refresh',
      loading: 'Scanning session logs…',
      error: 'Could not load token usage.',
      retry: 'Retry',
      empty: 'No token usage in the selected time range.',
      today: 'Today',
      last7: 'Last 7 days',
      last30: 'Last 30 days',
      all: 'All time',
      custom: 'Custom',
      from: 'From',
      to: 'To',
      total: 'Total',
      input: 'Input',
      output: 'Output',
      cacheRead: 'Cache read',
      cacheWrite: 'Cache write',
      byDay: 'Daily usage',
      byWorkspace: 'By workspace',
      workspace: 'Workspace',
      sessions: 'Sessions',
      unknownWorkspace: 'Other sessions',
      generated: 'Updated',
      scanned: '{count} sessions scanned',
      skipped: '{count} unreadable',
    }
    /** Chinese statistics copy. */
    const STATS_ZH = {
      panel: 'Token 统计',
      title: 'Token 统计',
      description: '本机全部工作区与会话（含子代理）的 provider 计费 token。',
      refresh: '刷新',
      loading: '正在扫描会话日志…',
      error: '无法加载 token 用量。',
      retry: '重试',
      empty: '所选时间范围内没有 token 消耗。',
      today: '今天',
      last7: '近 7 天',
      last30: '近 30 天',
      all: '全部',
      custom: '自定义',
      from: '开始',
      to: '结束',
      total: '总数',
      input: '输入',
      output: '输出',
      cacheRead: '缓存读',
      cacheWrite: '缓存写',
      byDay: '按天用量',
      byWorkspace: '按工作区',
      workspace: '工作区',
      sessions: '会话数',
      unknownWorkspace: '其他会话',
      generated: '更新于',
      scanned: '已扫描 {count} 个会话',
      skipped: '{count} 个读取失败',
    }

    /** Inject the panel stylesheet once per page. */
    function installStatsStyle() {
      const documentRef = globalThis.document
      if (documentRef === undefined || typeof documentRef.createElement !== 'function') return
      const tagId = 'dsh-dev-plugins/stats'
      if (documentRef.querySelector?.(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const style = documentRef.createElement('style')
      style.dataset.plugin = 'dsh-dev-plugins'
      style.dataset.pluginCss = tagId
      style.textContent = `
.dsh-stats-root{height:100%;overflow:auto;padding:24px 32px 48px;color:var(--dsw-alias-label-primary,#e8e8ea);background:var(--dsw-alias-bg-base,#0b0c10)}
.dsh-stats-header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:16px}
.dsh-stats-title{margin:0;font-size:20px;font-weight:600}
.dsh-stats-description{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#a5a7b0);font-size:13px;line-height:1.5}
.dsh-stats-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:20px}
.dsh-stats-segmented{display:inline-flex;flex-wrap:wrap;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l2,#2a2c33);border-radius:10px;background:var(--dsw-alias-fill-l1,#14151a)}
.dsh-stats-preset{border:0;border-radius:7px;padding:6px 10px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dsh-stats-preset[data-active=true]{background:var(--dsw-alias-fill-l2,#24262e);font-weight:600}
.dsh-stats-custom{display:inline-flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#a5a7b0)}
.dsh-stats-custom input{border:1px solid var(--dsw-alias-border-l2,#2a2c33);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#14151a);color:inherit;font:inherit;font-size:12px;padding:5px 7px}
.dsh-stats-refresh{margin-left:auto;border:1px solid var(--dsw-alias-border-l2,#2a2c33);border-radius:8px;padding:6px 12px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dsh-stats-refresh:disabled{opacity:.5;cursor:default}
.dsh-stats-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.dsh-stats-card{border:1px solid var(--dsw-alias-border-l2,#2a2c33);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1,#14151a)}
.dsh-stats-card-label{font-size:12px;color:var(--dsw-alias-label-secondary,#a5a7b0)}
.dsh-stats-card-value{margin-top:6px;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dsh-stats-section{margin-bottom:28px}
.dsh-stats-section-title{margin:0 0 12px;font-size:14px;font-weight:600}
.dsh-stats-chart{display:flex;align-items:flex-end;gap:4px;height:200px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2c33);overflow-x:auto}
.dsh-stats-bar-column{display:flex;flex:1 0 18px;flex-direction:column;align-items:stretch;justify-content:flex-end;height:100%;min-width:18px}
.dsh-stats-bar{width:100%;min-height:2px;border-radius:4px 4px 0 0;background:var(--dsw-alias-state-business-primary,#4d6bfe);opacity:.85}
.dsh-stats-bar:hover{opacity:1}
.dsh-stats-bar-label{margin-top:6px;color:var(--dsw-alias-label-secondary,#a5a7b0);font-size:10px;text-align:center;white-space:nowrap}
.dsh-stats-table{width:100%;border-collapse:collapse;font-size:13px}
.dsh-stats-table th,.dsh-stats-table td{padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2c33);text-align:right;white-space:nowrap}
.dsh-stats-table th:first-child,.dsh-stats-table td:first-child{text-align:left}
.dsh-stats-table th{color:var(--dsw-alias-label-secondary,#a5a7b0);font-weight:500}
.dsh-stats-path{margin-top:2px;max-width:420px;overflow:hidden;color:var(--dsw-alias-label-secondary,#a5a7b0);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.dsh-stats-state{padding:48px 0;color:var(--dsw-alias-label-secondary,#a5a7b0);font-size:14px;text-align:center}
.dsh-stats-error{color:var(--dsw-alias-state-error-primary,#ff8a8a)}
.dsh-stats-error button{margin-left:12px}
.dsh-stats-meta{margin-top:18px;color:var(--dsw-alias-label-secondary,#a5a7b0);font-size:11px}
`
      documentRef.head.appendChild(style)
    }

    /**
     * Register the sidebar statistics panel when the client slot services are
     * available. The panel reads its data from the Host's read-only route.
     * @param ctx - Client Cordis context.
     * @returns true when the panel was installed.
     */
    function installStatsPanel(ctx) {
      if (!statsEnabled()) return false
      if (typeof ctx?.inject === 'function') {
        let installed = false
        ctx.inject(['slots', 'locale'], (statsCtx) => {
          installed = installStatsPanelWith(statsCtx)
        })
        return installed
      }
      return installStatsPanelWith(ctx)
    }

    /**
     * Register the panel on a context that already carries `slots` and
     * `locale`; notifications stay independent of those services.
     * @param ctx - Client Cordis context with the slot and locale services.
     * @returns true when the panel was installed.
     */
    function installStatsPanelWith(ctx) {
      if (typeof ctx?.slots?.inject !== 'function' || typeof ctx?.locale?.bind !== 'function') return false
      let react
      try {
        react = require('react')
      } catch {
        return false
      }
      const h = react.createElement
      installStatsStyle()
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.locale.register(STATS_NS, { en: STATS_EN, zh: STATS_ZH }), 'dsh-dev-plugins: stats dictionaries')
      } else {
        ctx.locale.register(STATS_NS, { en: STATS_EN, zh: STATS_ZH })
      }
      const t = ctx.locale.bind(STATS_NS)

      /** One summary card. */
      function card(key, value) {
        return h(
          'div',
          { className: 'dsh-stats-card', key },
          h('div', { className: 'dsh-stats-card-label' }, t(key)),
          h('div', { className: 'dsh-stats-card-value' }, value),
        )
      }

      /** One daily bar chart of the returned day series. */
      function chart(days) {
        const maximum = Math.max(1, ...days.map((day) => day.totalTokens))
        const step = Math.max(1, Math.ceil(days.length / 12))
        return h(
          'div',
          { className: 'dsh-stats-chart' },
          days.map((day, index) =>
            h(
              'div',
              { className: 'dsh-stats-bar-column', key: day.date },
              h('div', {
                className: 'dsh-stats-bar',
                style: { height: `${Math.max(2, (day.totalTokens / maximum) * 100)}%` },
                title: `${day.date} · ${t('total')}: ${formatTokens(day.totalTokens)}`,
              }),
              index % step === 0
                ? h('span', { className: 'dsh-stats-bar-label' }, day.date.slice(5))
                : null,
            ),
          ),
        )
      }

      /** The workspace totals table. */
      function table(workspaces) {
        const headers = [t('workspace'), t('sessions'), t('total'), t('input'), t('output'), t('cacheRead'), t('cacheWrite')]
        return h(
          'table',
          { className: 'dsh-stats-table' },
          h('thead', null, h('tr', null, headers.map((label) => h('th', { key: label }, label)))),
          h(
            'tbody',
            null,
            workspaces.length === 0
              ? h('tr', null, h('td', { colSpan: headers.length, className: 'dsh-stats-state' }, t('empty')))
              : workspaces.map((workspace) =>
                  h(
                    'tr',
                    { key: workspace.id },
                    h(
                      'td',
                      null,
                      h('div', null, workspace.title === '' ? t('unknownWorkspace') : workspace.title),
                      workspace.path === '' ? null : h('div', { className: 'dsh-stats-path' }, workspace.path),
                    ),
                    h('td', null, String(workspace.sessions)),
                    h('td', null, formatTokens(workspace.totalTokens)),
                    h('td', null, formatTokens(workspace.uncachedInputTokens)),
                    h('td', null, formatTokens(workspace.outputTokens)),
                    h('td', null, formatTokens(workspace.cacheReadTokens)),
                    h('td', null, formatTokens(workspace.cacheWriteTokens)),
                  ),
                ),
          ),
        )
      }

      /** The statistics page registered into the `main` slot. */
      function StatsPage() {
        const [preset, setPreset] = react.useState('7d')
        const [customFrom, setCustomFrom] = react.useState(() => localDateInputValue(Date.now() - 6 * DAY_MS))
        const [customTo, setCustomTo] = react.useState(() => localDateInputValue(Date.now()))
        const [refreshToken, setRefreshToken] = react.useState(0)
        const [state, setState] = react.useState({ status: 'loading', data: null, error: null })
        const appliedRefresh = react.useRef(0)

        react.useEffect(() => {
          const controller = new AbortController()
          const refresh = refreshToken !== appliedRefresh.current
          appliedRefresh.current = refreshToken
          setState((previous) => ({ ...previous, status: 'loading', error: null }))
          const range = rangeForPreset(preset, Date.now(), customFrom, customTo)
          let timeZone
          try {
            timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
          } catch {
            timeZone = undefined
          }
          const base = globalThis.document?.baseURI ?? globalThis.location?.href ?? '/'
          const url = statsDataUrl(base, { ...range, timeZone, refresh })
          if (typeof globalThis.fetch !== 'function') {
            setState({ status: 'error', data: null, error: t('error') })
            return () => controller.abort()
          }
          globalThis
            .fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
            .then(async (response) => {
              if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
              return response.json()
            })
            .then((data) => setState({ status: 'ready', data, error: null }))
            .catch((error) => {
              if (error?.name === 'AbortError') return
              setState({ status: 'error', data: null, error: error?.message ?? t('error') })
            })
          return () => controller.abort()
        }, [preset, customFrom, customTo, refreshToken])

        const presets = [
          ['today', 'today'],
          ['7d', 'last7'],
          ['30d', 'last30'],
          ['all', 'all'],
          ['custom', 'custom'],
        ]
        const controls = h(
          'div',
          { className: 'dsh-stats-controls' },
          h(
            'div',
            { className: 'dsh-stats-segmented' },
            presets.map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'dsh-stats-preset',
                  'data-active': preset === value ? 'true' : 'false',
                  onClick: () => setPreset(value),
                },
                t(label),
              ),
            ),
          ),
          preset === 'custom'
            ? h(
                'div',
                { className: 'dsh-stats-custom' },
                h('span', null, t('from')),
                h('input', {
                  type: 'date',
                  value: customFrom,
                  onChange: (event) => setCustomFrom(event.target.value),
                }),
                h('span', null, t('to')),
                h('input', {
                  type: 'date',
                  value: customTo,
                  onChange: (event) => setCustomTo(event.target.value),
                }),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-stats-refresh',
              disabled: state.status === 'loading',
              onClick: () => setRefreshToken((value) => value + 1),
            },
            t('refresh'),
          ),
        )

        let body
        if (state.status === 'loading') {
          body = h('div', { className: 'dsh-stats-state' }, t('loading'))
        } else if (state.status === 'error') {
          body = h(
            'div',
            { className: 'dsh-stats-state dsh-stats-error' },
            `${t('error')} ${state.error ?? ''}`,
            h(
              'button',
              { type: 'button', className: 'dsh-stats-refresh', onClick: () => setRefreshToken((value) => value + 1) },
              t('retry'),
            ),
          )
        } else {
          const data = state.data
          const empty = data.totals.totalTokens === 0
          body = h(
            'div',
            null,
            h(
              'div',
              { className: 'dsh-stats-cards' },
              card('total', formatTokens(data.totals.totalTokens)),
              card('input', formatTokens(data.totals.uncachedInputTokens)),
              card('output', formatTokens(data.totals.outputTokens)),
              card('cacheRead', formatTokens(data.totals.cacheReadTokens)),
              card('cacheWrite', formatTokens(data.totals.cacheWriteTokens)),
            ),
            empty ? h('div', { className: 'dsh-stats-state' }, t('empty')) : null,
            h(
              'section',
              { className: 'dsh-stats-section' },
              h('h2', { className: 'dsh-stats-section-title' }, t('byDay')),
              chart(data.days),
            ),
            h(
              'section',
              { className: 'dsh-stats-section' },
              h('h2', { className: 'dsh-stats-section-title' }, t('byWorkspace')),
              table(data.workspaces),
            ),
            h(
              'div',
              { className: 'dsh-stats-meta' },
              `${t('scanned').replace('{count}', String(data.scannedSessions))} · ${t('generated')} ${new Date(data.generatedAt).toLocaleString()}`,
              data.skippedSessions > 0 ? ` · ${t('skipped').replace('{count}', String(data.skippedSessions))}` : '',
            ),
          )
        }

        return h(
          'div',
          { className: 'dsh-stats-root' },
          h(
            'header',
            { className: 'dsh-stats-header' },
            h('div', null, h('h1', { className: 'dsh-stats-title' }, t('title')), h('p', { className: 'dsh-stats-description' }, t('description'))),
          ),
          controls,
          body,
        )
      }

      /** Sidebar icon for the panel list. */
      function StatsIcon({ size = 16 }) {
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('path', {
            d: 'M2 13.5V9h2.5v4.5H2Zm4.5 0V6H9v7.5H6.5Zm4.5 0V2.5h2.5v11H11Z',
            fill: 'currentColor',
          }),
        )
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: STATS_PANEL_ID, locale: STATS_NS }, StatsPage),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: STATS_PANEL_ID, order: 55, locale: STATS_NS, label: () => t('panel') },
          StatsIcon,
        ),
      )
      return true
    }


    /** The browser Notification constructor, when the context exposes it. */
    function notificationApi() {
      return typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined
    }

    /** Ask for notification permission on the first user gesture. */
    function armPermissionRequest(api) {
      if (api === undefined || api.permission !== 'default') return
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      let asked = false
      const ask = () => {
        if (asked) return
        asked = true
        try {
          const result = api.requestPermission()
          if (result !== undefined && typeof result.catch === 'function') result.catch(() => {})
        } catch {
          /* the browser may reject the request outside a user gesture */
        }
      }
      document.addEventListener('pointerdown', ask, { capture: true, once: true })
      document.addEventListener('keydown', ask, { capture: true, once: true })
    }

    /** Only notify while the tab is hidden or the window lost focus. */
    function pageNeedsAttention() {
      if (typeof document === 'undefined') return false
      if (document.visibilityState !== undefined && document.visibilityState !== 'visible') return true
      if (typeof document.hasFocus === 'function') return !document.hasFocus()
      return false
    }

    function localized() {
      const language = globalThis.navigator === undefined ? '' : String(globalThis.navigator.language ?? '')
      return language.toLowerCase().startsWith('zh')
    }

    /** Resolve a notification label, or undefined for subagent/removed sessions. */
    function sessionLabel(sessions, sessionId) {
      let row
      let address
      try {
        address = sessions?.subagentAddress?.(sessionId)
      } catch {
        address = undefined
      }
      if (address !== undefined) return undefined
      try {
        row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
      } catch {
        row = undefined
      }
      // Unknown or not-yet-listed Sessions must not be guessed: the old
      // fallback labelled an unlisted subagent as "Session" and notified.
      if (row === undefined || row === null) return undefined
      if (row.removed === true) return undefined
      if (row.parentSessionId !== undefined && row.parentSessionId !== null) return undefined
      // The client list row for a team subagent can omit parentSessionId but
      // still carries origin/depth; use both as defensive filters.
      if (row.origin === 'subagent') return undefined
      if (typeof row.depth === 'number' && row.depth > 0) return undefined
      if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim()
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') {
        const base = row.cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop()
        if (base !== undefined && base !== '') return base
      }
      return localized() ? '会话' : 'Session'
    }

    function completionMessage(label) {
      return localized()
        ? { title: `任务完成：${label}`, body: 'Agent 现在空闲，可以查看结果。' }
        : { title: `Task finished: ${label}`, body: 'The agent is idle again.' }
    }

    /** A failure notification, with the Host error's first line as detail. */
    function failureMessage(label, detail) {
      const text = detail === undefined || detail === null ? '' : String(detail).trim().split('\n')[0].slice(0, 180)
      if (localized()) {
        return {
          title: `任务失败：${label}`,
          body: text === '' ? 'Agent 因错误停止。' : text,
        }
      }
      return {
        title: `Task failed: ${label}`,
        body: text === '' ? 'The agent stopped with an error.' : text,
      }
    }

    /** Whether the page currently shows this session as its main view. */
    function isMainSession(sessions, sessionId) {
      try {
        const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
        return (row?.retainedBy?.mainView ?? 0) > 0
      } catch {
        return false
      }
    }

    /** Session-local storage, when the browser allows it. */
    function localStorageOrUndefined() {
      try {
        return globalThis.localStorage
      } catch {
        return undefined
      }
    }

    function readStored(key) {
      try {
        const raw = localStorageOrUndefined()?.getItem(key)
        return raw === null || raw === undefined ? undefined : JSON.parse(raw)
      } catch {
        return undefined
      }
    }

    function writeStored(key, value) {
      try {
        localStorageOrUndefined()?.setItem(key, JSON.stringify(value))
      } catch {
        /* storage can be disabled; coordination then degrades to per-tab */
      }
    }

    /** The Session the current page shows as its main view, if any. */
    function currentMainSessionId(sessions) {
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId ?? {}
        for (const id of Object.keys(byId)) {
          if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
        }
      } catch {
        /* ignore a temporarily unavailable list */
      }
      return undefined
    }

    /** Publish this tab's focused main Session so other tabs can suppress duplicates. */
    function syncViewing(sessions) {
      const documentRef = globalThis.document
      const visible = documentRef === undefined || documentRef.visibilityState === undefined || documentRef.visibilityState === 'visible'
      const focused = visible && (typeof documentRef?.hasFocus !== 'function' || documentRef.hasFocus())
      const current = readStored(VIEW_KEY)
      if (focused) {
        writeStored(VIEW_KEY, {
          pageId: PAGE_ID,
          sessionId: currentMainSessionId(sessions) ?? null,
          focused: true,
          at: Date.now(),
        })
        return
      }
      if (current?.pageId === PAGE_ID) {
        writeStored(VIEW_KEY, { pageId: PAGE_ID, sessionId: null, focused: false, at: Date.now() })
      }
    }

    /** Whether another focused tab is currently viewing this Session. */
    function anotherPageViewing(sessionId, now = Date.now()) {
      const claim = readStored(VIEW_KEY)
      return (
        claim !== undefined &&
        claim !== null &&
        claim.pageId !== PAGE_ID &&
        claim.focused === true &&
        claim.sessionId === sessionId &&
        typeof claim.at === 'number' &&
        now - claim.at <= PEER_TTL_MS
      )
    }

    /** Elect one tab to raise the notification so hidden tabs do not duplicate it. */
    function claimNotification(sessionId, kind, now = Date.now()) {
      const key = `${CLAIM_PREFIX}${sessionId}:${kind}`
      const claim = readStored(key)
      if (
        claim !== undefined &&
        claim !== null &&
        claim.pageId !== PAGE_ID &&
        typeof claim.at === 'number' &&
        now - claim.at <= CLAIM_TTL_MS
      ) {
        return false
      }
      writeStored(key, { pageId: PAGE_ID, at: now })
      return true
    }

    /** Remember one Host agent error until the matching idle transition arrives. */
    function recordAgentError(errors, sessionId, message, now = Date.now()) {
      errors.set(sessionId, { message: String(message ?? ''), at: now })
    }


    /** Consume a recent agent error; stale records are dropped. */
    function recentAgentError(errors, sessionId, now = Date.now()) {
      const record = errors?.get(sessionId)
      if (record === undefined) return undefined
      if (!(now - record.at <= ERROR_WINDOW_MS)) {
        errors.delete(sessionId)
        return undefined
      }
      return record
    }

    function pendingMessage(label, pending) {
      const kind = pending === null || typeof pending !== 'object' ? undefined : pending.kind
      const toolName =
        pending !== null && typeof pending === 'object' && typeof pending.toolName === 'string'
          ? pending.toolName
          : undefined
      if (localized()) {
        if (kind === 'approval') {
          return {
            title: `需要批准：${label}`,
            body: toolName === undefined ? '有工具调用等待你的批准。' : `工具 ${toolName} 等待你的批准。`,
          }
        }
        if (kind === 'plan-review') {
          return { title: `需要确认计划：${label}`, body: '计划等待你的确认。' }
        }
        return { title: `需要你的输入：${label}`, body: 'Agent 正在等待你的回答。' }
      }
      if (kind === 'approval') {
        return {
          title: `Approval needed: ${label}`,
          body: toolName === undefined ? 'A tool call is waiting for approval.' : `Tool ${toolName} is waiting for approval.`,
        }
      }
      if (kind === 'plan-review') {
        return { title: `Plan review needed: ${label}`, body: 'A plan is waiting for your confirmation.' }
      }
      return { title: `Input needed: ${label}`, body: 'The agent is waiting for your answer.' }
    }

    /** Show one browser notification. */
    function announce(message) {
      const api = notificationApi()
      if (api === undefined || api.permission !== 'granted') return undefined
      // Background sessions notify even while the page is focused; the session
      // the page is showing only needs a notification once the page is hidden.
      if (!enabled() || (!pageNeedsAttention() && message.mainSession === true)) return undefined
      if (message.sessionId !== undefined && anotherPageViewing(message.sessionId)) return undefined
      if (
        message.sessionId !== undefined &&
        message.notifyKind !== undefined &&
        !claimNotification(message.sessionId, message.notifyKind)
      ) {
        return undefined
      }
      try {
        const notification = new api(message.title, {
          body: message.body,
          tag: message.tag,
          requireInteraction: message.requireInteraction === true,
        })
        live.add(notification)
        const release = () => {
          live.delete(notification)
        }
        notification.onclose = release
        notification.onerror = release
        notification.onclick = () => {
          try {
            globalThis.focus?.()
          } catch {
            /* focus can be denied; the click still closes the notification */
          }
          try {
            notification.close()
          } catch {
            release()
          }
        }
        return notification
      } catch {
        return undefined
      }
    }

    /** Turn one status snapshot change into at most one notification per session. */
    function handleStatusChange(previous, next, ctx, emit = announce, errors, now = Date.now()) {
      if (!enabled() || next === undefined || next === null) return
      next.forEach((status, sessionId) => {
        const before = previous === undefined ? undefined : previous.get(sessionId)
        const label = sessionLabel(ctx?.sessions, sessionId)
        if (label === undefined) return
        const pending = status === undefined ? undefined : status.pendingInteraction
        if (pending !== undefined) {
          const beforeKey = before?.pendingInteraction?.key
          if (beforeKey === pending?.key) return
          emit({
            ...pendingMessage(label, pending),
            tag: `dsh-dev-plugins:${sessionId}:pending`,
            requireInteraction: true,
            immediate: true,
            mainSession: isMainSession(ctx?.sessions, sessionId),
            sessionId,
            notifyKind: 'pending',
          }, sessionId)
          return
        }
        if (before?.running === true && status?.running === false) {
          const failure = recentAgentError(errors, sessionId, now)
          if (failure !== undefined) {
            errors.delete(sessionId)
            emit({
              ...failureMessage(label, failure.message),
              tag: `dsh-dev-plugins:${sessionId}:error`,
              requireInteraction: true,
              mainSession: isMainSession(ctx?.sessions, sessionId),
              sessionId,
              notifyKind: 'error',
            }, sessionId)
            return
          }
          emit({
            ...completionMessage(label),
            tag: `dsh-dev-plugins:${sessionId}:complete`,
            mainSession: isMainSession(ctx?.sessions, sessionId),
            sessionId,
            notifyKind: 'complete',
          }, sessionId)
        }
      })
    }

    /** Read the dsh-dev-plugins entry revision from a boot manifest object. */
    function bootEntryRev(boot) {
      if (boot === undefined || boot === null || !Array.isArray(boot.entries)) return undefined
      const entry = boot.entries.find((candidate) => candidate?.id === 'dsh-dev-plugins')
      return typeof entry?.rev === 'string' ? entry.rev : undefined
    }

    /** Parse the boot manifest out of an index page. */
    function parseBootRev(html) {
      const marker = 'globalThis["__DSH_BOOT__"] = '
      const start = html.indexOf(marker)
      if (start === -1) return undefined
      const end = html.indexOf('</script>', start)
      if (end === -1) return undefined
      try {
        const boot = JSON.parse(html.slice(start + marker.length, end).trim().replace(/;$/u, ''))
        return bootEntryRev(boot)
      } catch {
        return undefined
      }
    }

    /** Reload a stale page when the served bundle revision moved on. */
    async function checkForUpdate() {
      const current = bootEntryRev(globalThis.__DSH_BOOT__)
      if (current === undefined || typeof globalThis.fetch !== 'function') return
      let latest
      try {
        const response = await globalThis.fetch('/', { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) return
        latest = parseBootRev(await response.text())
      } catch {
        return
      }
      if (latest === undefined || latest === current) {
        try {
          globalThis.sessionStorage?.removeItem(RELOAD_GUARD_KEY)
        } catch {
          /* ignore */
        }
        return
      }
      try {
        if (globalThis.sessionStorage?.getItem(RELOAD_GUARD_KEY) === latest) return
        globalThis.sessionStorage?.setItem(RELOAD_GUARD_KEY, latest)
      } catch {
        /* ignore storage restrictions and reload once anyway */
      }
      try {
        globalThis.location?.reload()
      } catch {
        /* no reload in this context */
      }
    }

    /**
     * Subscribe to the unified Session status source and notify while the page
     * is in the background. Requires the `sessions` and `uiSession` services.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      installStatsPanel(ctx)
      if (!enabled()) return
      const api = notificationApi()
      if (api === undefined) return
      armPermissionRequest(api)
      const source = ctx.uiSession?.sessionStatus
      if (source === undefined || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return
      const errors = new Map()
      if (ctx.remote?.$on !== undefined) {
        ctx.effect(
          () =>
            ctx.remote.$on('api-session/error', (sessionId, message) => {
              recordAgentError(errors, sessionId, message)
            }),
          'dsh-dev-plugins: agent errors',
        )
      }
      let previous = source.getSnapshot()
      const timers = new Map()
      const cancel = (sessionId) => {
        const timer = timers.get(sessionId)
        if (timer === undefined) return
        clearTimeout(timer)
        timers.delete(sessionId)
      }
      const publish = (message, sessionId) => {
        if (message.immediate === true) {
          cancel(sessionId)
          announce(message)
          return
        }
        cancel(sessionId)
        timers.set(
          sessionId,
          setTimeout(() => {
            timers.delete(sessionId)
            const current = source.getSnapshot().get(sessionId)
            // A retry, queued continuation, or new pending input resumed the
            // session; only a settled idle session deserves a notification.
            if (current === undefined || current.running !== false || current.pendingInteraction !== undefined) return
            // Re-evaluate the main view at fire time: the user may have switched
            // Sessions during the settle delay.
            announce({ ...message, mainSession: isMainSession(ctx?.sessions, sessionId) })
          }, SETTLE_MS),
        )
      }
      ctx.effect(() => {
        const dispose = source.subscribe(() => {
          const next = source.getSnapshot()
          next.forEach((status, sessionId) => {
            if (status?.running === true || status?.pendingInteraction !== undefined) cancel(sessionId)
          })
          handleStatusChange(previous, next, ctx, publish, errors)
          previous = next
        })
        return () => {
          dispose()
          for (const timer of timers.values()) clearTimeout(timer)
          timers.clear()
        }
      }, 'dsh-dev-plugins: settled browser notifications')

      ctx.effect(() => {
        const sync = () => syncViewing(ctx.sessions)
        sync()
        const interval = setInterval(sync, 2000)
        const documentRef = globalThis.document
        const onVisibility = () => sync()
        const onFocus = () => sync()
        const onBlur = () => sync()
        documentRef?.addEventListener?.('visibilitychange', onVisibility)
        documentRef?.addEventListener?.('focus', onFocus)
        documentRef?.addEventListener?.('blur', onBlur)
        const disposeList = ctx.sessions?.list?.subscribe?.(sync)
        return () => {
          clearInterval(interval)
          documentRef?.removeEventListener?.('visibilitychange', onVisibility)
          documentRef?.removeEventListener?.('focus', onFocus)
          documentRef?.removeEventListener?.('blur', onBlur)
          disposeList?.()
        }
      }, 'dsh-dev-plugins: cross-tab viewing state')

      if (typeof globalThis.fetch === 'function' && typeof globalThis.location?.reload === 'function') {
        ctx.effect(() => {
          const check = () => {
            void checkForUpdate()
          }
          check()
          const interval = setInterval(check, UPDATE_POLL_MS)
          const documentRef = globalThis.document
          const onVisibility = () => {
            if (documentRef?.visibilityState === 'visible') check()
          }
          documentRef?.addEventListener?.('visibilitychange', onVisibility)
          return () => {
            clearInterval(interval)
            documentRef?.removeEventListener?.('visibilitychange', onVisibility)
          }
        }, 'dsh-dev-plugins: stale bundle check')
      }
    }

    module.exports = {
      apply,
      inject,
      name,
      __test: {
        announce,
        armPermissionRequest,
        completionMessage,
        enabled,
        statsEnabled,
        failureMessage,
        formatTokens,
        localDateInputValue,
        parseDateInput,
        rangeForPreset,
        statsDataUrl,
        startOfLocalDay,
        endOfLocalDay,
        handleStatusChange,
        bootEntryRev,
        claimNotification,
        currentMainSessionId,
        isMainSession,
        anotherPageViewing,
        parseBootRev,
        recordAgentError,
        syncViewing,
        recentAgentError,
        SETTLE_MS,
        pageNeedsAttention,
        pendingMessage,
        sessionLabel,
      },
    }
    return module.exports
  },
})
