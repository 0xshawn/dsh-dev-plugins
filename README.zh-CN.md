# dsh-dev-plugins

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

一组以单个 bundle 安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件。当前版本让 dsh 的 Web UI 可以通过**非 localhost 地址**访问 —— 反向代理、SSH 隧道或局域网地址均可 —— 无需修改已安装的 dsh 源码，并附带浏览器通知、工作区 token 用量页，以及回车换行的输入框。

[English](./README.md)

## 解决的问题

上游 `dsh web` 是为"浏览器在同一台机器"设计的。换用其它权威（authority）访问时有六处缺失或失效：

| 问题 | 上游行为 | 本插件 |
|---|---|---|
| `/api` 的 Host/Origin 信任围栏 | 只接受 loopback、监听绑定的 IP 字面量和 `--trusted-host`；经代理的权威访问所有 RPC 返回 `403` | 把 `DSH_DEV_PLUGINS_TRUSTED_HOSTS` 中的权威追加进同一列表（`--trusted-host` 继续有效） |
| 页面视图（`connection.isLoopback`） | 仅由 `location.hostname` 判定；经代理的页面被当作非回环，dsh 0.2.0 下设置只存在于进程内存（Models 页报 `settings are unavailable in this browser`），所有版本都会隐藏打开宿主机配置文件的操作 | 注入 `__DSH_TRANSPORT__ = { ownsHost: true }` —— dsh 桌面壳使用的宿主自有传输钩子 —— 已认证页面因此呈现回环视图 |
| 启动令牌 | 每个进程随机生成，重启后只能从服务日志里找登录 URL | 通过 `DSH_WEB_TOKEN`（或插件配置）固定令牌，重启后登录 URL 不变 |
| 首次登录 | 直接打开裸地址返回纯文本 `401`，必须使用打印出来的 `?token=` URL | 裸地址上提供 HTML 令牌输入框（`loginPage`，默认开启），提交后仍走上游的令牌交换 |
| 后台提醒 | 标签页在后台时，任务完成或等待批准/回答都不可见 | 用浏览器通知提醒任务完成和待处理输入（`notifications`，默认开启） |
| Token 用量历史 | 聊天统计条只显示当前会话，没有跨会话或工作区视图 | 增加侧边栏 **Token 统计** 页，从宿主持久化会话日志按工作区和日期聚合 provider 计费 token（`statsPage`，默认开启） |

认证机制不变：浏览器仍需用启动令牌换取与权威绑定的签名会话 Cookie，每次 `/api` 请求仍先经过 Host/Origin 围栏。本插件只消除部署摩擦，不新增也不绕过访问控制。

## 安装

```sh
# 从 GitHub 安装（公开仓库，无需构建）
dsh plugin --profile web add git+https://github.com/0xshawn/dsh-dev-plugins.git

# 或从本地源码安装
dsh plugin --profile web add /path/to/dsh-dev-plugins
```

之后重启 `dsh web`（dsh 在启动时加载 bundle）。确认插件行已生效：

```sh
dsh --profile web --dump-config | grep -A6 'dsh-dev-plugins'
```

卸载：`dsh plugin --profile web remove dsh-dev-plugins`，下次重启即恢复上游默认行为。

> **0.5.0 起改名。** 原包名为 `dsh-remote-access`；profile 行名与环境变量现为 `dsh-dev-plugins` 和 `DSH_DEV_PLUGINS_TRUSTED_HOSTS`。请先移除旧行再添加新行，并同步修改服务环境中的变量名。

### 从源码 patch 迁移

如果现有部署是通过 patch 已安装的 dsh bundle 实现（固定启动令牌 + 强制回环判定），迁移步骤：

1. 安装脚本里不再执行 patch；`npm install -g @deepseek-ai/dsh@<version>` 之后不需要补 patch 步骤。
2. 按上面的方式把本 bundle 装进 `web` profile，重启 `dsh web`。
3. 保留部署原有的 `DSH_WEB_TOKEN`（变量名相同，直接沿用）；`--trusted-host` 可继续使用，也可改配 `DSH_DEV_PLUGINS_TRUSTED_HOSTS`。
4. 确认启动日志仍打印固定令牌：`dsh web: ...?token=<同一个令牌>`。

## 配置

### 环境变量

| 变量 | 取值 | 作用 |
|---|---|---|
| `DSH_DEV_PLUGINS_TRUSTED_HOSTS` | 逗号分隔的裸权威，如 `dsh.example.com,dsh.example.com:8443` | 追加到 `--trusted-host`；不带端口的条目匹配任意端口 |
| `DSH_WEB_TOKEN` | 非空启动令牌 | 固定登录令牌；为空或未设置时保持上游的每进程随机令牌 |

两者都可以放在 systemd 的 `Environment=`/`EnvironmentFile=`、launchd 的 `EnvironmentVariables`、Docker 环境变量或 shell profile 中。习惯命令行参数时继续用 `--trusted-host` 即可；表达式会把这些环境权威追加到命令行列表之后。注意 patch 层会整体替换 `connection.config`：若另一个层（或更靠后的 profile patch）覆盖了 `connection`，需要在那里重新写上 `trustedHosts`（否则环境权威会丢失），并补齐仍需保留的键，例如 `cookieMaxAgeDays`、`recovery`。

```sh
DSH_WEB_TOKEN="$(cat /etc/dsh/web-token)" \
DSH_DEV_PLUGINS_TRUSTED_HOSTS="dsh.example.com" \
dsh web --host 127.0.0.1 --port 3080 --no-open
```

非法权威（带 scheme、路径、userinfo 或补零端口）会在启动时以上游的校验错误中止，而不是被静默忽略。

### 插件配置

需要按 profile 覆盖时，编辑 `$DSH_HOME/profiles/web/cordis.patch.yml` 中的 `dsh-dev-plugins` 行：

```yaml
- id: dsh-dev-plugins
  config:
    # false 表示保持上游按权威判定的页面视图。
    loopback: true
    # 固定令牌；留空则回退到 DSH_WEB_TOKEN，再回退到随机令牌。
    # 推荐使用 DSH_WEB_TOKEN：profile 配置以明文保存。
    launchToken: ''
    # 未带令牌或 Cookie 直接打开裸地址时，显示令牌输入框。
    # 设为 false 可恢复上游的纯文本 401。
    loginPage: true
    # 启用浏览器通知的客户端半边。
    notifications: true
    # 启用侧边栏 Token 统计页及其只读数据路由。
    statsPage: true
    # 让聊天输入框的回车插入换行。
    composerNewline: true
    # 启用浏览器控制 MCP 工具（重启 dsh web 后生效）。
    browserControl: true
```

设置 → **开发插件** 提供同样的开关表单，不必手改此文件。

### 首次登录：不用带 token 的 URL

未认证的浏览器直接打开裸部署地址时，会看到一个简单的登录表单，而不是纯文本 `401`。表单把令牌提交回相对的 index 路径（`GET ./?token=...`），因此上游的令牌交换、签名 Cookie、反代挂载前缀和跳转到干净 URL 的逻辑全部照旧。令牌错误时表单重新显示并给出错误提示；令牌正确则完成登录。

只有请求权威已经通过部署的 Host/Origin 围栏（loopback、监听绑定字面量，或 `DSH_DEV_PLUGINS_TRUSTED_HOSTS`/`--trusted-host` 中的权威）时才会返回表单；不受信任的权威仍得到纯文本 `401`，因此 DNS rebinding 或外部主机无法借此收集令牌。令牌仍然出现在查询串里（与打印的 URL 相同），也仍然是唯一凭据；表单没有引入第二套密码存储，也没有绕过认证。若前置代理已有自己的登录页，可设 `loginPage: false` 恢复上游 `401`。

### 反向代理

`--public-url https://dsh.example.com/` 负责对外公布浏览器使用的地址（打印的 URL、`DSH_WEB_URL`、运行时上下文），本插件不改变这一点。代理仍需：

- 原样保留浏览器侧的 `Host`（围栏逐字比较）；
- 转发前剥掉挂载前缀；
- 带上 `Upgrade`/`Connection` 转发 WebSocket 升级；
- 把 Cookie 的 `Path` 重写到挂载点，并在 HTTPS 侧补 `Secure`。

完整清单见上游文档 [Publish the Web UI behind a reverse proxy](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/public-deployments.md)。TLS 终结、网络隔离、谁能访问监听端口，仍由运维方负责。

### 浏览器通知

bundle 还带一个手写、无需构建的浏览器客户端：监听 Session 状态源，在以下情况发浏览器通知：

- 顶层会话从运行中变为空闲 —— `任务完成：<标题>`；
- 同一次空闲转变前有 Host agent 错误 —— `任务失败：<标题>`，正文取错误首行；
- 会话开始等待批准、计划确认或回答 —— `需要批准` / `需要确认计划` / `需要你的输入`。

失败信息来自转发的 `api-session/error` 事件，并与随后的空闲转变配对，因此模型调用失败、回合中止或工具循环报错会显示失败原因，而不是笼统的“任务完成”。任何通过 `uiSession` 注册的待处理交互都会触发通知；当前 dsh 版本注册的是批准和用户提问（含计划确认），未来未知的交互类型会回退到通用的 `需要你的输入` 文案。

后台会话的完成/失败通知即使页面在前台也会发出；当前页面正在查看的主会话则只在页面隐藏或窗口失焦时通知。待审批/提问不受主视图限制。会话空闲后，完成/失败通知会延迟 3 秒。

多个标签页通过 localStorage 协调：聚焦标签页发布自己正在查看的会话，其他标签页对该会话不再发通知，并用认领机制避免隐藏标签页重复通知。客户端每 15 秒获取一次服务端 boot manifest，插件 bundle 版本变化时自动 reload，避免热更新后旧页面继续跑旧通知逻辑（首次引入该检查的这一版仍需手动刷新一次）。如果窗口期内会话因重试、排队的后续消息或新的待处理输入重新运行，通知会被取消，避免“失败后马上重试”这类无效通知。

只有页面不可见或窗口失去焦点时才通知，且必须先获得浏览器的通知权限。页面会在第一次点击/按键时请求一次权限（按来源授权）。点击通知会把 dsh 窗口切到前台，并在当前页面打开被通知的会话。子代理会话和已移除会话会被跳过，未知或尚未出现在列表中的会话不会被猜测成通知。插件配置 `notifications: false` 可关闭通知半边（输入框回车改写仍然生效）。

限制：这里用的是页面级 Web Notification，不是 Web Push。dsh 页面必须保持打开（可以切到后台）；浏览器完全关闭后不会收到通知。通知权限需要安全上下文，因此使用 HTTPS 或 loopback，局域网纯 HTTP 不行。通知正文包含会话标题，锁屏预览可能暴露它。

### Token 统计

侧边栏新增 **Token 统计** 入口，打开后包含：

- 时间预设（今天、近 7 天、近 30 天、全部、自定义），日界按浏览器 IANA 时区计算；控件配色随当前浅色/深色主题变化；
- 按天柱状图展示 provider 计费 token；
- 汇总卡片：总数、未缓存输入、输出、缓存读、缓存写；
- 工作区表格：会话数与同样的四列 token。

数据来自宿主持久化的会话日志，通过 `ctx.sessionQuery` 读取且不会激活任何 Agent。插件重放与上游 `tokenUsage` 投影相同的 provider usage 样本：每个 Turn/step 一次结算，重试的 step 按替换后的 attempt 计入；fork 继承的事件前缀会被跳过，避免子会话重复计算父会话用量。子代理会话计入统计，并沿父会话链归到对应工作区；未登记工作区的会话按目录单列，没有目录的会话归入“其他会话”。

首次打开会扫描全部历史，可能需要几秒；之后的请求复用按会话的折叠缓存，由实时 `session/event` 标脏增量更新。页面上的 **刷新** 按钮会强制全量重扫。用量归属于结算事件所在的本地日期，因此跨午夜的 Turn 计入结算当天。设置 `statsPage: false` 可同时移除侧边栏页面和数据路由。

页面读取 `GET /dsh-dev-plugins/stats/data?from=<毫秒>&to=<毫秒>&tz=<IANA>`（`from`/`to` 可选，`refresh=1` 强制重扫）。该路由只读，并执行与 `/api` 相同的受信任权威和启动令牌 Cookie 校验；只返回 token 总量、工作区 id/标题/路径、日期键和扫描元数据，不返回消息内容。

### 设置页

设置 → **开发插件** 是一张开关表单，每项 bundle 功能一个开关，默认全部打开：回环页面视图、令牌登录页、浏览器通知、Token 统计页、输入框回车换行、浏览器控制。写入走宿主配置表单，因此会作为普通插件配置写进 profile patch，重启后仍然保留。

宿主侧开关是 volatile 配置：运行中的插件实时读取，因此登录页和统计路由改完立即生效，无需重启，客户端热更新或 Host 插件重载后也保持一致。作用于浏览器半边的开关（通知、统计入口、回车换行）需要刷新页面，页面在写入后会显示刷新提示条。浏览器控制是启动时拉起的 MCP 子进程，必须重启 `dsh web` 才生效。

### 输入框：回车换行

dsh 聊天输入框原本回车发送、Shift+回车换行。本 bundle 把普通回车改为换行，发送改用 Cmd/Ctrl+回车或发送按钮。改写只作用于聊天输入框的 Lexical 编辑器：其他输入框的回车、以及斜杠命令/提及/文件菜单打开时的回车都保持上游行为；被改写的按键不会发送消息，输入法组词期间也不处理。可在设置页关闭 `composerNewline` 开关（或在插件配置里设 `composerNewline: false`）。会话运行中时，键盘发送走 dsh 的加速提交路径，因此不会遵循发送按钮仍然遵循的排队/插话偏好。

### 浏览器控制

bundle 还带一个 Chrome 扩展和一个本地 bridge，把浏览器变成 dsh 工具：会话中模型可以像 DevTools 一样操作你本机的 Chrome —— 点击、输入、导航、等待、截图、读 DOM、执行页面 JS、看网络请求、读写 Cookie/存储。工具名形如 `mcp__browser__*`，bridge 由 bundle 的 `mcp-browser` 行自动拉起，不需要额外 MCP 配置。

控制是全自动的：bridge 按需 attach 目标 tab，也可以自由切 tab，所以该 Chrome 里打开的任何页面都可能被读取或操作。只在你接受这个范围时安装扩展。dsh 自身的审批仍然生效（每条工具调用可能询问一次；dsh 没有 allow-always 规则），请配合你认可的权限预设使用。

**安装。** bridge 随 bundle 装好即可；扩展使用内置固定 token，无需配对。扩展：

1. 打开 `chrome://extensions`，启用开发者模式，选 **加载已解压的扩展程序**，选中本包的 `extension/` 目录（通过 profile 安装时为 `~/.dsh/profiles/web/node_modules/dsh-dev-plugins/extension`）。Chrome 会请求 `debugger`、`tabs`、`storage`、`alarms`、`downloads` 权限。
2. 重启 `dsh web`，让 bundle 的 `mcp-browser` 行拉起 bridge。扩展会自动重连；弹窗显示 **Connected** 与已 attach 的 tab 即成功。只有 bridge 设置 `DSH_BROWSER_BRIDGE_TOKEN` 时才需要在弹窗的“Token override”里填同样的值。从 0.7.0/0.7.1 升级时，扩展里旧的随机 64 位十六进制 token 会自动清除一次；自定义的十六进制 override 需要重新填一次。

需要运行 `dsh web` 的机器上有 Chrome 120+；attach 期间 Chrome 会显示“正在由自动化测试软件控制”提示条。bridge 只监听 `127.0.0.1`。

**工具**（均返回 JSON；截图额外返回 image 内容块）：

| 工具 | 用途 |
|---|---|
| `tabs` | 列出、新建、切换、关闭 tab |
| `navigate` | URL、后退、前进、刷新；默认等待加载完成 |
| `observe` | 返回 URL、标题、页面文本，以及带稳定 `ref` 的可交互元素 |
| `screenshot` | 视口、整页、元素或 `ref` 截图 |
| `wait` | 等元素、等文本、等网络空闲或超时 |
| `click` | 按 `ref`（或 CSS selector）真实鼠标点击 |
| `type` | 向输入框输入文本，可先清空或提交 |
| `key` | 组合键，如 `Control+A`、`Shift+Enter`、`Escape` |
| `scroll` | 元素或视口滚动 |
| `dialog` | 处理 `alert`/`confirm`/`prompt` |
| `evaluate` | 在页面执行 JavaScript，返回 JSON 值 |
| `network` | 开始/停止抓包、列请求、取单个响应体（上限 2MB） |
| `upload` | 从允许的本地目录为文件输入框选文件 |
| `download` | 把 URL 抓取到本地下载目录，或列出 Chrome 最近的下载 |
| `cookies` | 读取、设置、清除 Cookie |
| `storage` | 读取、设置、清除 `localStorage`/`sessionStorage` |

交互类工具优先用 `ref`，回退 CSS `selector`；`evaluate` 是一切兜底。`ref` 在下一次 `observe`、页面导航或切 tab 后失效，过期会返回提示让模型重新 observe。

**安全与限制。** 全部本地：`127.0.0.1` 上的 WebSocket、共享 token（默认内置固定值，可覆盖）、`Origin: chrome-extension://<id>` 校验（可选按扩展 ID 白名单收紧，建议其他本机扩展不可信时启用）。每次工具调用写入 `$DSH_HOME/browser-bridge/audit.jsonl`，不记录密钥与输入文本。`upload` 只能读 `DSH_BROWSER_BRIDGE_UPLOAD_ROOTS`（默认 `~/Downloads,~/Desktop`）下的真实文件，`download op:"url"` 只写 `DSH_BROWSER_BRIDGE_DOWNLOAD_DIR`（默认 `~/Downloads/dsh-browser`）——页面自身触发的下载仍走 Chrome 的下载目录设置；截图只作为 image 内容块返回、不落盘；网络响应体只在内存。危险工具可用 `DSH_BROWSER_BRIDGE_DISABLE` 单独关闭；`DSH_BROWSER_BRIDGE=0` 让 bridge 直接退出，不注册任何浏览器工具。设置页的 **浏览器控制** 开关通过插件配置表达同样意图，bridge 在启动时读取，因此修改后要重启 `dsh web`。

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_BROWSER_BRIDGE` | `1` | `0` 关闭 bridge 与全部浏览器工具（设置页开关重启后等效） |
| `DSH_BROWSER_BRIDGE_PORT` | `8790` | 本地 WebSocket 端口 |
| `DSH_BROWSER_BRIDGE_TOKEN` | 内置固定值 | 私有部署的 token 覆盖 |
| `DSH_BROWSER_BRIDGE_HOME` | `$DSH_HOME/browser-bridge` | 审计目录 |
| `DSH_BROWSER_BRIDGE_EXTENSION_ID` | 空 | 允许的扩展 ID（逗号分隔） |
| `DSH_BROWSER_BRIDGE_UPLOAD_ROOTS` | `~/Downloads,~/Desktop` | 上传允许根目录 |
| `DSH_BROWSER_BRIDGE_DOWNLOAD_DIR` | `~/Downloads/dsh-browser` | bridge 侧下载目录 |
| `DSH_BROWSER_BRIDGE_DISABLE` | 空 | 禁用的工具（逗号分隔） |
| `DSH_BROWSER_BRIDGE_NETWORK_LIMIT` | `500` | 网络抓包环形缓冲大小 |

无头服务器上没有 Chrome 可 attach，不装扩展、让 bridge 空转即可（或设 `DSH_BROWSER_BRIDGE=0`）。

## 工作原理

本包是一个 dsh **bundle**：`cordis.patch.yml` 是叠加在 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 之上的 patch 层，用到以下扩展点。

1. **信任权威 —— patch 层。** 在 `connection` 行的 `trustedHosts` 上把环境变量列表拼接到命令行列表之后。表达式优先读取 0.2.0 的 `ctx.get('webRuntime')`（其中已包含通配绑定推导出的 LAN 字面量与命令行附加项），再回退到 0.2.1 的 `ctx.get('webStartup')`；0.2.0 同时提供这两个服务，因此必须优先 runtime，否则会丢掉通配绑定的 LAN 权威。一份 patch 覆盖两种布局。Host/Origin 围栏与 `allowsRemoteAuthorities` 判定都交回上游实现。
2. **回环视图 —— index 注入。** 宿主插件监听 `webserver/index-inject`，向返回的 index 注入一段内联经典脚本：

   ```js
   if (globalThis.__DSH_TRANSPORT__ === void 0) globalThis.__DSH_TRANSPORT__ = { ownsHost: true };
   ```

   `ClientTransportHooks.ownsHost` 是上游"本页面拥有 Host"的标志，但文档将其保留给自行组装 transport 的 shell，并声明服务端返回的页面从不携带该全局变量。本 bundle 有意设置它来获得 owner 视图：`dsh-client-connection` 据此报告回环视图，但页面仍使用正常的 HTTP + WebSocket 传输。守卫语句不会覆盖真实 shell 提供的 transport，脚本在 shell 入口和全部客户端插件之前执行。
3. **启动令牌 —— 服务字段。** 插件等待 `ctx.connection` 就绪，在 Loader 结算前设置 `connection.browserAuth.launchToken`，打印的认证 URL 与令牌校验因此统一使用固定值。若未来 dsh 隐藏该字段，插件会显式报错，而不是悄悄退回随机 URL。
4. **登录表单 —— index 授权。** 插件包装 `connection.authorizeIndex`：`dsh-host-frontend-static` 在返回 index 前调用它。来自受信任权威、未认证的 GET index 请求得到令牌表单（内容为 HTML 的 `401`）；已认证、携带有效令牌、来自不受信任权威或非 GET 的请求都交回上游实现。插件卸载时恢复原方法。若未来 dsh 移除该方法，表单会静默禁用，裸地址恢复上游纯文本 `401`，其余功能不受影响。


5. **通知 —— 客户端插件。** `package.json` 声明 `dsh.client`（`platform: web`）并导出 `./client`；`dsh-client-modules` 把浏览器 bundle 发给页面。客户端通过 `sessions` 与 `uiSession` 服务订阅 `ctx.uiSession.sessionStatus`，在本地发 Web Notification；`ctx.remote.$on('api-session/error')` 为下一次空闲转变提供失败详情。宿主侧只注入 `config.notifications` 对应的 `__DSH_DEV_PLUGINS_NOTIFY__` 开关。
6. **Token 统计 —— 宿主路由加客户端页面。** 每个会话日志被折叠成 provider usage 结算记录（`assistant/message`/`assistant/attempt` 的 usage 样本，处理替换与重试），并按会话 id 缓存。`session/event` 监听器把会话标脏，下次请求只重读变化部分。宿主在 `ctx.webServer` 上注册精确路由 `/dsh-dev-plugins/stats/data`，并用 `connection.isTrusted` 与 `connection.browserAuth.isAuthenticated` 校验。浏览器半边注册 `main` 面板与 `sidebar.panellist` 入口；宿主根据 `config.statsPage` 注入 `__DSH_DEV_PLUGINS_STATS__` 开关。

8. **浏览器控制 —— MCP bridge 加扩展。** bundle patch 插入一行 `@deepseek-ai/dsh-mcp-client`（`mcp-browser`，`serverName: browser`），stdio 命令是当前 Node 解释器，参数是按 `$DSH_HOME/profiles/$DSH_PROFILE/node_modules/dsh-dev-plugins/` 解析出的 `bridge/index.js`。bridge 提供 MCP 工具和本机 WebSocket 中继；MV3 扩展连中继、持有 `chrome.debugger`、转发 CDP 命令与事件。工具调用及其触碰的页面内容都不离开本机。

## 安全说明

- **启动令牌就是凭据。** 持有打印出来的 `?token=` URL 即可换取会话 Cookie 并获得完整 owner 权限。请谨慎分发；固定令牌是长期凭据，绝不能提交到仓库。修改 `DSH_WEB_TOKEN` 并重启只会让旧 URL 失效，**不会**吊销已经签发的 Cookie（默认有效期 `cookieMaxAgeDays` 为 30 天）；要真正吊销，请清除该站点的 Cookie，或删除 browser-session 凭据记录后重启。
- **信任权威不等于认证。** 它只让该权威通过 Host/Origin 围栏；签名会话 Cookie 仍把守每个 RPC。不要把监听端口暴露到不受信任的网络；需要时用 TLS 和自控代理。
- **回环视图是权限决定。** dsh 0.2.0 下它让已认证远程浏览器的设置改为写入宿主机；所有版本下它会暴露仅限本机的界面操作，例如 **Open configuration file** 会在**宿主机**的编辑器里打开设置文件。远程浏览器本来就持有 owner 凭据；希望保持上游最小权限视图的运维方可以设置 `loopback: false`。
- **回环视图超出了文档化的客户端契约。** 上游把 `ownsHost` 保留给自行组装 transport 的 shell，并声明服务端返回的页面从不携带该全局变量；本 bundle 有意设置它。当前 dsh 的所有消费方都只把它用于 `isLoopback`，但未来或第三方客户端插件可能把它当作宿主所有权的证明。设置 `loopback: false` 可消除该暴露面。
- **纯 HTTP 会泄露令牌。** 在代理侧或通过 `--tls-cert/--tls-key` 终结 TLS；Cookie 的 `Secure` 行为见上游文档。
- **通知会在系统通知/锁屏上显示会话标题。** 权限按浏览器来源授予；对共享屏幕或锁屏环境敏感时可用 `notifications: false` 关闭。
- **登录表单不做限流。** 它只是把同一个高熵启动令牌的输入入口暴露出来；对公网端点仍建议在代理层做限流。Host/Origin 围栏拒绝的权威永远不会看到表单。
- **统计路由会暴露用量元数据。** 它与 `/api` 使用同一套启动令牌 Cookie 和受信任权威围栏；返回内容只有按工作区/按天的 token 总量和工作区路径，不含提示词、回复或工具参数。持有 owner 凭据的人本来就能看到完整界面；`statsPage: false` 可移除该路由。
- **不要新增会拦截内联脚本的 CSP。** 回环视图行是一段内联经典脚本；dsh 自身的启动全局变量已经要求内联脚本权限，但代理注入的不含 `'unsafe-inline'`（或未用 nonce 覆盖）的 CSP 会静默拦截该脚本，而页面仍能加载。

7. **输入框回车 —— 客户端捕获监听。** 客户端半边在页面 document 上安装一个捕获阶段的 `keydown` 监听器。位于聊天输入框 Lexical 编辑器内（`[data-composer-card]` 中的 `[data-lexical-editor="true"]`）的普通回车会被取消，并重放成上游已经映射为换行的 Shift+回车；Cmd/Ctrl+回车仍然发送。斜杠命令、提及或文件菜单（`[data-trigger-menu]`）打开时，以及输入法组词期间，不执行改写。

## 兼容性

- 已在 dsh `0.2.1-rc.2`、`0.2.1-rc.3` 与 `0.2.0-rc.2` 的 Web profile 上验证。
- 声明范围：`engines.dsh >=0.2.0-0 <0.3.0-0`。dsh 0.1.x 不受支持，也未测试。
- dsh 0.2.0 中 profile 级通配绑定（`webserver.host: 0.0.0.0`）会推导出 LAN 权威；本 patch 会保留它们，因此打印出的 LAN URL 无需额外 trusted-host 即可使用。
- 插件行仅适用于 Web profile；没有 `connection` 服务的 profile 中该行保持 inactive，安装也不会生效。
- `npm install -g @deepseek-ai/dsh@<version>` 升级 dsh 不会改动 profile，插件继续可用；升级后重启 `dsh web` 即加载新版本。
- 固定令牌依赖 `connection.browserAuth.launchToken` 字段。若 dsh 改变该结构，配置了令牌时插件会在启动阶段报错；取消令牌配置或升级插件即可。
- 浏览器控制需要 Chrome 120+ 并以“加载已解压”方式装扩展；attach 期间因 `debugger` 权限会显示 Chrome 自动化提示条。无头服务器没有 Chrome，bridge 空转，工具返回 `bridge_disconnected`。
- patch 按 `$DSH_HOME` 与 `$DSH_PROFILE` 解析 `bridge/index.js`；若启动 `dsh web` 时没有这两个变量，则回退到 `~/.dsh` 和 `web` profile。用其他 profile 名时需要设置这两个变量（上游 CLI 会导出它们）。
- 输入框回车改写依赖 dsh 内部 DOM 标记（`[data-composer-card]`、`[data-lexical-editor="true"]`、`[data-trigger-menu]`）。若未来 dsh 改名，监听器找不到输入框便静默失效，恢复上游“回车发送”，不会破坏页面。
- 登录表单包装 `connection.authorizeIndex` 并读取 `browserAuth.isAuthenticated`。若未来 dsh 移除二者，表单会被跳过，裸地址恢复上游纯文本 `401`，插件其余功能继续工作。
- 浏览器通知依赖客户端模块系统、`ctx.uiSession.sessionStatus` 与 `ctx.sessions`；若未来 dsh 移除其中任一项，客户端半边会静默失效，宿主半边继续工作。通知要求页面保持打开，没有 service worker 或 push 订阅。
- Token 统计依赖 `ctx.sessionQuery`（`listSessions` 与 `readSession`）、`ctx.workspaceRegistry`（可选；缺失时回退为按目录分组）以及 `ctx.webServer.register`。会话查询服务缺失时，数据路由返回 `503`，页面显示加载错误。
- 固定动作只在启动时执行一次。宿主插件热重载（HMR）可能用 dsh 缓存的每进程令牌重建 Connection 服务，且不会重新打印启动 URL；更换令牌或升级 dsh 后请重启 `dsh web`。

## 开发

```sh
npm install
npm test        # node:test：配置、令牌解析、index 注入、用量折叠与路由鉴权单元测试
```

隔离 home 的端到端验证（不影响真实 profile）：

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile web add "$PWD"
DSH_WEB_TOKEN=dev-token DSH_DEV_PLUGINS_TRUSTED_HOSTS=dsh.test \
  dsh --profile web --host 127.0.0.1 --port 3199 --no-open
# 再通过你的代理打开 http://<非 localhost 地址>:3199/?token=dev-token
```

## 许可证

[MIT](./LICENSE) © 2026 shawn
