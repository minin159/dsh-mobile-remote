# 阶段 0 · 探针结论（probe-findings）

> 生成：2026-09-02。探针代码在 `probe/`，原始输出在 `probe/results/`（gitignore，不入库）。
> 六项均给出三态结论 + 证据；阶段 1 的选型以本文为准，不再重新推导。

## 结论速览

| 项 | 结论 | 一句话 |
|---|---|---|
| P1 webServer | **证实** | exact/prefix 路由、WS 升级、SSE、Content-Type 全部可用（9/9 实测 PASS）；通道选 **SSE**，页面走 prefix 路由内联返回 |
| P2 agent.steer | **证实** | 无需武装、无频控、1s/10s 间隔三连发全部入队并被模型消费；source 标记按预期落盘 |
| P3 approval/request | **证实** | allowed-once/rejected 均生效且 GUI 不再弹；**宿主无默认超时，插件必须自带**（挂起实测阻塞 25s 后 abort→cancelled） |
| P4 会话枚举 | **证实** | `ctx.get('sessions').list()` + `ctx.get('sessionQuery').listSessions()`（32 条历史实测）+ 事件自带会话 id，阶段 2 切换可做 |
| P5 手机连通 | **证实（局域网侧）** | 手机（微信 WebView + Edge Android）实测打开页面并建连 SSE（31–183ms）；ping RTT 16–38ms；息屏回前台走「整页重载」而非 SSE 重连 → 阶段 1 需按 lastEventId 补发；生产 DSH 默认只绑 127.0.0.1，阶段 1 需 `--host 0.0.0.0` |
| P6 二维码 | **证实** | 内联 MIT qrcode-generator：node 出 SVG（v5，7.4KB）+ 浏览器 canvas 双端可用，零依赖；扫码终验并入 P5 清单 |
| P7 上下文/缓存（5a） | **证实** | `assistant/message` 事件自带 `usage`（同 turn 第二请求实测 `cacheReadTokens:1792`）；宿主 `tokenMeter` 服务 + contextPressure 投影直出 `pressureTokens`/`contextWindow`——◐ 真控件可做 |
| P8 运行时切模型（5a） | **证实（官方路径）** | `sessionController.selectModel` → `agents.selectForNextRequest`：写 `model/selection` 会话事件（实测可从插件追加并回流）+ 下一请求生效 + 同步全局默认（副作用）；插件侧 agent/request 自改写双样式实测未落地 → 未定，不建议依赖 |
| P9 思考强度（5a） | **证实（机制）/ 按模型显隐** | reasoningEffort 是 per-request 请求头配置，模型自带档位目录（pi-ai：off/minimal/low/medium/high/xhigh/max）；本机 GLM-5.3-flash 未声明目录（reasoning=undefined）→ 🧠 控件按模型能力动态显隐，本机现状为隐藏 |

---

## P1 webServer 能力 —— 证实

**结论：** `dsh-host-webserver` 支持多 exact + prefix 路由、WebSocket 升级、SSE 与完整 Content-Type 控制。**阶段 1 选型：SSE（EventSource）为主通道 + POST 控制接口；页面由 prefix 路由 `/mobile-remote/` 内联 HTML 返回。WS 可行但不采用**（宿主只交付原始 socket，RFC6455 帧要自己写——探针中 ~70 行只覆盖文本帧；SSE + POST 已完全覆盖需求，且浏览器端 EventSource 自带重连）。

**证据：**

1. 源码（宿主包 `@deepseek-ai/dsh-host-webserver` 0.1.2-alpha.1，`lib/index.js`）：
   - `register(route)`：`kind === 'exact' ? exact : prefixes` 两张表；重复路径抛错（:176-184）。
   - `registerUpgrade(route)`：精确 pathname 升级路由，handler 收 `(req, socket, head)`，协议握手与连接内容归插件（:190-198、:260-290）。
   - 匹配顺序：先 exact 表，再最长 prefix（`pathname.startsWith(prefix + '/')`），最后 fallback（:322-330）。
   - handler 抛错 → 400 且进程不退；upgrade handler 抛错 → 销毁 socket（README「失败时的行为」+ 实测 P1.9）。
2. 实测（`probe/p1-webserver.mjs`，与宿主同包独立装配，9/9 PASS，见 `results/p1-result.json`）：
   - exact 多条并存、`kind:'prefix'` 深层路径、HTML + `text/html`、SSE `text/event-stream` 流式 3 事件、手写 RFC6455 握手+帧回显（`ws://…/probe/ws` echo PASS）、未匹配 404、重复注册抛错、handler 抛错 400。
3. 生产形态补充：web 组合的 webserver 配置为 `host: ctx.webStartup.host ?? '127.0.0.1'`，`port: … ?? 3080`（`dsh --profile web --dump-config` 实查）；当前运行实例即 `127.0.0.1:3080`（netstat）。**手机要直达必须以 `dsh web --host 0.0.0.0` 启动**（web app 自带 `--host/--port` 旗标，`--profile web --help` 实查）。

**降级预案：** 无需——P1 全过，无降级项。（若未来宿主升级破坏 prefix 行为，页面可退化为单 exact 路由 + 查询参数。）

## P2 agent.steer 持续对话 —— 证实

**结论：** steer 不需要任何前置「武装窗口」，无频控；运行中消息入队并被模型逐条消费；空闲唤醒是 `dsh-agent-loop` 的一等代码路径（headless 载体在首个 turn 结束后即退出进程，未能在该载体上现场复现唤醒，但源码 + phone-push 生产使用双重佐证）。**MVP 可「随时发消息」；发送节流按 UI 防连点设计（2s），不是宿主要求。**

**证据：**

1. 源码（`dsh-agent-loop/lib/index.js`）：
   - `steer(input)` = `send(input, "next-step", true)`（:401）；`send` 把消息插入 inbox 并 `wakeDriver`（:388-394）。
   - `wakeDriver`：空闲时直接 `setPhase(running)` 开新轮，注释明言「A wake sent while idle always opens its turn boundary」（:410-448）；全程无频控/冷却逻辑。
2. 实测（`results/p2.log`，headless 载体 probe profile）：
   - 工具内连续 steer 3 次（间隔 0s/1s/10s）全部成功，无异常无节流；
   - 三条消息均以 `user/message` 事件落会话，`source:{kind:'plugin',plugin:'mobile-remote-probe'}` 与 roadmap 决策 6 的来源标记约定完全一致；
   - 模型输出明确逐条确认消费（「探针消息1/2/3 → 1-收到/2-收到/3-收到」）。
3. 空闲唤醒佐证：(a) 上述源码注释；(b) phone-push 生产功能「失败后 steer 空闲会话续命」在本机日常可用（其 docs/roadmap.md 阶段 1 已验收）。headless 载体的补发 steer 落在已失活上下文（`results/p2.log` 末行 error：`cannot get required service "agents" in inactive context`）——这是 headless「答完即退」的载体行为，不是 steer 限制。
4. 阶段 1 验收仍安排真机复测空闲唤醒（手机发消息给空闲会话）。

**降级预案：** 无需。若真机复测发现空闲唤醒异常（未预期），退化为「空闲会话收到消息先回执、待会话活跃时投递」的产品语义。

## P3 approval/request 拦截语义 —— 证实

**结论：** 手机审批的「混合回落」形态成立：插件 handler 返回 `'allowed-once'`/`'rejected'` 即终局生效（工具按决定继续/中止，GUI 不再弹）；返回 `next()` 则交回原应答链（web 组合里就是 GUI 弹窗）。**关键发现：宿主没有默认超时——handler 不响应就一直阻塞，插件必须自带超时定时器**（阶段 1 默认 120s，到点 `next()`）。

**证据：**

1. 源码（`dsh-user-approval/lib/index.js`）：服务名 `approval`（:89，`ctx.get('approval')` 可直接用）；结果词汇 `allowed-once / rejected / cancelled / unavailable`（:30-33）；`decide()` 把 waterfall 与请求的 abort 信号赛跑，无应答者/抛错/词汇外返回 → `unavailable`（fail-closed，:180-195）；`signal === undefined` 时纯等 waterfall（:193）。
2. 实测（probe profile，真实 approval 服务 + 真实审计事件，`results/p3-*.log`）：
   | 模式 | handler 行为 | request() 返回 | 耗时 | 审计 `approval/decided` |
   |---|---|---|---|---|
   | p3-allow | 返回 `'allowed-once'` | `allowed-once` | 2ms | `allowed-once` |
   | p3-reject | 返回 `'rejected'` | `rejected` | 2ms | `rejected` |
   | p3-none | `next()`（无其他应答者） | `unavailable` | 1ms | `unavailable` |
   | p3-hang | 挂起 30s | `cancelled`（25s abort 信号触发） | 25004ms | `cancelled` |
3. GUI 行为推断链：决策返回 → waterfall 终止（首个应答者即终局）→ GUI 应答者不再被询问；`next()` → 继续问 GUI。phone-push 生产使用（手机审批 + 超时回落电脑端）长期验证同一语义。
4. 审计事件对 `approval/asked` + `approval/decided` 在 `session/event` 流里可实时观察（实测日志）——mobile-remote 的审计 JSONL 可直接复用此流。

**降级预案：** 无需。若 web GUI 与插件的应答顺序出现未预期行为（同级监听器顺序「不是策略优先级机制」，理论上无保证），以实测为准；phone-push 既有生产事实表明插件 handler 可靠先答。

## P4 会话枚举与标识 —— 证实

**结论：** 插件可枚举多会话并拿到稳定标识。**阶段 2 的「会话列表与切换」判定为可做**；MVP 绑定当前会话的实现路径也全部打通。

**证据：**

1. 源码：`dsh-session` 的 `SessionStore` 服务名 `sessions`，`list()` 返回全部 live 会话（lib/types/index.js:918）；`dsh-session-query` 提供 `ctx.sessionQuery`（web 组合挂载 `session-query-sqlite`，`dsh --profile web --dump-config` 实查；headless 组合亦实测挂载），`listSessions()` 返回全量逻辑会话（live 优先、newest-first、带 `live`/`persisted` 标志）。
2. 实测（`results/p4.log`，headless probe profile）：
   - 当前会话：`exec.agent.session.header.id` → `session-04a4f45a-…`；
   - live 枚举：`ctx.get('sessions').list()` → 1 条，含 `header.{createdAt,cwd}` 与事件数；
   - `ctx.get('sessionQuery').listSessions()` → **32 条**（含用户历史持久化会话，newest-first，`rawKeys:["header","live","persisted"]`）；
   - `session/event` 每条事件自带 `subject.header.id`；`user/message` 的 `source` 区分 `kind:'user'` 与 `kind:'plugin',plugin:'…'`。
3. 配套能力（阶段 2 用）：`sessionQuery` 还提供 `readSession/filterSessions/readTitleSnapshots/readSurface/traceSession/searchSessions`（包 README 能力表）。

**降级预案：** 无需。

## P5 手机端连通性 —— 证实（局域网侧；Tailscale 侧未测）

**结论：** 局域网形态全链路实测通过：手机浏览器打开 token 页、SSE 建连、数据往返、页面 JS（含内联 QR 库）均正常。**两个对阶段 1 有直接影响的实测事实：① 安卓浏览器息屏回前台通常走「整页重载」而非 SSE 重连——页面加载时必须带上次事件 id 向服务器补发断档（EventSource 的 Last-Event-ID 只覆盖瞬时断线，不覆盖整页重载）；② 生产 DSH web 默认只绑 `127.0.0.1:3080`，手机可达必须 `dsh web --host 0.0.0.0` 启动。**

**实测数据（2026-09-02，`results/p5-events.jsonl` + `p5-server.log`；手机 = 192.168.10.20，Wi-Fi）：**

| 项 | 结果 |
|---|---|
| 页面加载（token 路径） | ✅ 两个浏览器成功：微信内置 WebView（MicroMessenger 8.0.77，Android 16/vivo V2458A）与 Edge Android 151 |
| SSE 首次建连 | ✅ 31ms（微信）/ 183ms（Edge 首次冷启）/ 46–98ms（温启动）；桌面侧同页 59–67ms |
| 数据通道 RTT（POST /ping） | ✅ 16–38ms，典型 ~25ms（连发 35 次无失败） |
| 页面 JS + 内联 QR 库 | ✅ 事件上报到达 = 页面脚本完整执行；手机端两次拉取 `/qr.svg` |
| 双码扫码（P6 终验） | ✅ 用户确认通过（扫码动作无服务器上报通道，按完成确认记录） |
| 息屏唤醒恢复 | ⚠️ 部分：日志中出现 hidden→回前台，路径是**新 page_loaded（整页重载，SSE 46–98ms 重建）**而非 `sse_reconnect`；未观察到 ≥1 分钟的息屏长断口。阶段 1 验收仍保留「息屏 5 分钟」项，按重载路径验收 |
| Tailscale 地址 | ❌ 未测：本机当时未连 Tailscale（无 100.x 地址）；出门场景首次使用前补测 |

**对阶段 1 的设计修正（已回写 spec）：** 页面加载/重载时带 `?since=<lastEventId>` 查询参数，服务器从环形缓冲补发断档——整页重载是安卓端的主恢复路径，SSE 自动重连只是次路径。

**降级预案（保留）：** 手机不可达时优先查防火墙对 node 入站放行；Tailscale 项不可达不影响 MVP（局域网为主场景）。

## P6 二维码呈现 —— 证实

**结论：** 「设置页 client.js 内联小型 QR 生成」路线可行且为零依赖。**MVP 选型：把 vendored MIT 实现（qrcode-generator 1.4.4，Kazuhiko Arase，MIT 头保留）内联进 client.js/页面，浏览器端直接渲染；设置页保留「复制链接」兜底。** 服务端 SVG 路线同样可用（已验证），留作备选。

**证据：**

1. `probe/p6-qrcode-generator.js`：单文件 2297 行，UMD（node 走 `module.exports`，浏览器内联后用全局 `qrcode`），零运行时依赖。
2. `probe/p6-qr.mjs`：node 端生成 —— 测试 URL（与真实链接同形，45B）自动选 **版本 5 / 33×33 模块**，SVG 7.4KB；结构校验三项全过（三个定位图案、时序图案、暗模块，`results/p6-result.json`）。
3. 浏览器端：同一份库已内联进 P5 页面（页面 200、canvas 渲染在客户端跑）。
4. 终验（解码正确性）并入 P5 清单第 3 项：手机实扫双码应得同一 URL。

**降级预案：** 无需。

---

## 对阶段 1 的影响（已回写 `phase-1-spec.md`）

1. 通道：SSE（EventSource）+ POST，不做 WS 自实现帧（P1）。
2. 审批：混合回落，**插件自带 120s 超时 → next()**（P3：宿主无默认超时）。
3. 页面：prefix 路由 `/mobile-remote/` 内联返回（P1）；二维码 client 端内联渲染（P6）。
4. 部署前提：`dsh web --host 0.0.0.0`（P5），写入阶段 1 验收前置条件。
5. 会话标识：`session/event` 的 `subject.header.id` + `exec.agent.session.header.id`；阶段 2 切换用 `sessionQuery.listSessions()`（P4）。

---

# 阶段 5a · 底栏控件探针结论（P7–P9）

> 生成：2026-09-02。探针插件在 `probe/plugin5a/`（mobile-remote-probe5a），原始输出在 `probe/results/`
> （p7.log、p8*.log、p9*.log，gitignore）。运行环境与命令见 `probe/README.md` 的 5a 节。
> 宿主包版本：dsh 全家桶 0.1.2-alpha.1（`C:\Users\lq\.dsh\profiles\node_modules\@deepseek-ai\`，
> 与运行中 Desktop 实例同源），cordis 4.0.1。本机 LLM：provider `zai-coding-cn`（dsh-llm-pi-ai
> 适配器，9 个 GLM 模型，默认 GLM-5.3-flash，contextWindow 1,000,000）。

## P7 上下文用量 / 缓存命中 —— 证实

**结论：** session 事件流携带逐请求 token 用量（含缓存命中字段），宿主另有现成的聚合层可直接读出
「上下文占用 + 容量」——**◐ 控件判为可做真控件，无降级需要**。三个可用数据源（按接入成本排序）：

1. **`assistant/message` 会话事件的 `usage` 字段**（mobile-remote 的 SSE 转发已在流上，零新增成本）：
   `TokenUsage {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`。
   `turn/end` 事件本身不带 usage——P7 任务问句的直接回答是：**用量挂在 assistant/message，不挂在 turn/end**。
2. **`contextPressure` 投影**（`ctx.get('sessionProjections').stateOf(session, 'contextPressure')`）：
   直接给出 `{pressureTokens, contextWindow, surfaceTokens}`——占用分子与容量分母都是现成的。
3. **`tokenMeter.measure(session)`** 服务调用（dsh-base 挂载，headless/web 全组合可用）：
   返回 `{baseline: {kind: 'usage'|'estimated'|'none', usage?, tokens}, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes}`。

**证据：**

1. 源码：
   - `dsh-agent-loop/lib/index.js:647/:681` —— `session.append("assistant/message", {turn, step, message, ...usage})`；
     `message.source = {provider, model, replayState?}`（当前模型名的观测点，P8 复用）。
   - `dsh-llm/lib/typert.host.js:463` —— TokenUsage 结构（含 cacheRead/cacheWrite/reasoningTokens）。
   - `dsh-token-meter/lib/index.js:583-600` —— TokenMeter 服务（`super(ctx, "tokenMeter")`）：注册
     `tokenUsage`/`contextPressure`/`contextBreakdown` 三投影，监听 session/event 同步；`:278` 上下文压力口径
     `pressureFrom = inputTokens + cacheReadTokens + cacheWriteTokens`。
   - `dsh-llm/lib/index.js`（服务面）—— `resolveModelInfo(provider, model)` 返回 `{context: {contextWindow}, reasoning, ...}`。
2. 实测（`results/p7.log`，GLM-5.3-flash 真实一轮带工具调用）：
   - 事件流 usage：step1 `{inputTokens:7808, outputTokens:42, totalTokens:7850}`（首轮无缓存字段）；
     step2（同 turn 的工具结果续请求）`{inputTokens:6086, outputTokens:6, totalTokens:7884, **cacheReadTokens:1792**}` ——
     **缓存命中由 provider 上报、pi-ai 适配器透传、会话事件携带，全链路实测成立**。
   - 投影现值：`tokenUsage.totals = {uncachedInputTokens:7808, outputTokens:42, cacheReadTokens:0→1792, cacheWriteTokens:0}`；
     `contextPressure = {surfaceTokens:199, contextWindow:1000000, pressureTokens:7808}`；
     `contextBreakdown = {systemTokens:1099, toolsTokens:7175, messageTokens:199}`（底栏可顺带展示构成）。
   - `tokenMeter.measure()` 实测返回 `baseline.kind='estimated'`（provider 上报总量低于启发式锚点时回落估算，
     `kind='usage'` 时带原始 usage）——展示层建议以投影/事件为准，measure 留作精确查询。
3. 缓存命中率口径建议：`cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`（与 pressureFrom 同源）。

**降级预案：** 无需。若未来宿主改字段名，SSE 流上的 `usage` 缺失时控件整体隐藏即可（防御式渲染）。

## P8 运行时切换模型 —— 证实（官方路径）；插件自实现路径未定

**结论：** DSH 有完整的 per-session 运行时模型切换机制：**`sessionController`（dsh-api-session-controller，
web 组合挂载，即生产 web UI 模型选择器的后端）** 的 `selectModel({sessionId, provider, model, reasoningEffort?})`：
经 `llm.resolveCallConfig` 校验 → `agents.selectForNextRequest(agent, selected)` →
**① 追加 `model/selection` 会话事件**（内建事件类型，持久化 + `modelSelection` 投影折叠，跨重启恢复）→
**② 安装 agent 作用域选择 waterfall，自下一请求生效**（切在步骤边界，不撕裂进行中的轮）→
**③ 顺手把选择保存为全局默认模型**（`agentDefaultModel.saveSelection`——副作用，5b 需知悉并决定是否接受）。
**cube 控件判为可做**。插件不经过 sessionController、自行在 `agent/request` waterfall 上改写模型的做法
（afterNext 改写返回值 / veto 直返完整配置两种样式）在 headless 载体上**实测均未落地 → 未定，禁止依赖**。

**证据：**

1. 源码：
   - `dsh-api-session-controller/lib/index.js:609` selectModel；`:320-322` selectForNextRequest =
     `agent.session.append("model/selection", selection)` + `selectionFor(agent).current = selection`；
     `:264-311` selectionFor（从 `sessionProjections.stateOf(session, "modelSelection")` 取 pending，装
     `installModelSelection`）；`:2662` 服务名 `sessionController`，构造时装 `installModelSelectionProjection`。
   - `dsh-agent/lib/index.js:255-303` installModelSelection：`system-prompt/assemble` 注入 provider/model 变量 +
     `agent/request` 改写（provider/model/reasoningEffort），注释明言 "a concurrent switch takes effect on a
     later step instead of splitting the two surfaces"。
   - `dsh-session/lib/index.js:1075` —— `model/selection` 为内建会话事件类型；`dsh-api-session-controller/:2043-2099`
     modelSelection 投影（state `{lastUsed, pending}` → view `{lastUsed, next}`，折叠 `model/selection` 事件）。
   - `dsh-llm/lib/index.js` 服务面 —— `listProviders()` / `listModels(provider)` / `resolveModelInfo()` /
     `resolveCallConfig()`（模型目录与校验，弹层数据源）。
   - web 组合挂载链：`dsh-web-app/package.json` 依赖 `dsh-api-session-controller`（生产模型选择器即此路径）；
     headless（dsh-base+dsh-headless）**不含**该包 → probe profile 实测 `ctx.get('sessionController') === undefined`。
2. 实测（`results/p8.log`/`p8b.log`/`p8c.log`，headless）：
   - 模型目录：`listProviders()` → `[deepseek-official, zai-coding-cn]`；`listModels('zai-coding-cn')` → 9 个 GLM 模型；
     `resolveCallConfig` 对当前与目标模型均校验通过（返回归一化 `{provider, model}`）。
   - **`model/selection` 可由插件写入**：`session.append('model/selection', {provider, model})` 成功（seq 43），
     事件回流 `session/event` 实测可见——切换记录的持久化/投影/重启恢复路径存在且插件可达。
   - 当前模型读取：`session.requestHeader().config`（`request/header` 事件同源）与 `assistant/message.source.{provider,model}`
     双路实测一致；每次生效配置变化会追加 `request/header`（reason:'change'）与 `request/context` 事件——
     **移动端"当前模型"的实时显示走既有 SSE 流即可**。
   - **未定项（三轮复现）**：插件在 `exec.agent.ctx` 上 `ctx.on('agent/request')` 改写——`await next()` 后改写返回值
     （afterNext）与不调 `next()` 直返完整配置（veto，cordis 否决语义）两种样式，监听器均触发、返回值均正确，
     但生效请求头不变（无 `request/header` change 事件、`assistant/message.source.model` 不变）。日志时序与
     cordis 4.0.1 waterfall 单链组合语义矛盾（两份 cordis 副本同版本；独立微测组合正常），根因未查明，
     按任务规则如实记未定。
3. 与 P2 的衔接：切换对 steer 唤醒的新轮同样生效（选择在 agent 作用域，轮边界快照）——源码语义，未单独实测。

**降级预案：** 5b 路线按优先级——
① 官方路径：mobile-remote 运行于 web 组合内，`ctx.get('sessionController')` 理论可达（5b 开工时先冒烟一行确认），
调 `commands.selectModel({sessionId, provider, model})`；
② 最小方案：控件只读显示当前模型（`requestHeader`/SSE 流），切换引导用户在桌面端操作；
③ 插件自实现 waterfall 改写：**未定，不采用**，除非 5b 阶段在 web 实例复测翻转。
另：官方路径的「同步改全局默认」副作用若不可接受，5b 可在切换后把 `agentDefaultModel` 设回原值（或与用户确认接受）。

## P9 思考强度档位 —— 证实（机制存在且完备）；档位目录按模型声明，本机模型未声明

**结论：** `reasoningEffort` 是 **per-request 请求头配置**（与模型选择同一传输面，宿主有完整校验与目录），
但**档位目录是 per-model 声明的**：`resolveModelInfo(provider, model).reasoning` 为
`{efforts: [{id, name, description?}], defaultEffort?}` 或 undefined。本机 `zai-coding-cn` 的 GLM-5.3-flash
**未声明目录（实测 reasoning = undefined）**——对未声明模型注入 effort 会被宿主直接拒绝
（`UNSUPPORTED_REASONING_EFFORT`）。**🧠 控件判为「按模型能力动态显隐」：模型无目录 → 隐藏（本机现状）；
有目录 → 弹层列出 efforts 选档**。与 ZCode 同款行为（模型不支持就不显示）。

**证据：**

1. 源码：
   - `dsh-llm/lib/typert.host.js:267/:295` —— `GenerateOptions`/`LlmCallConfig` 含 `reasoningEffort?: ReasoningEffortId`
     （"model, reasoning effort, and sampling values are request-header state"，per-request 可变）；
     `:335-343` `LlmModelReasoningInfo {efforts, defaultEffort?}` / `LlmReasoningEffortInfo {id, name, description?}`。
   - `dsh-llm/lib/index.js:1630-1646` resolveCallWithInfo：模型无 reasoning 目录 + 请求带 effort → 抛
     `UNSUPPORTED_REASONING_EFFORT`；有目录 → 校验档位合法性、未指定时补 `defaultEffort`；
     `request/header` 的 `adapterDefaults.reasoningEffort:true` 标记「effort 来自适配器默认」。
   - 档位词汇（per-adapter）：`dsh-llm-pi-ai/lib/index.js:290-298` THINKING_LEVELS =
     `off/minimal/low/medium/high/xhigh/max`（wire 格式 `thinking.effort`，per-model `reasoningEfforts` 声明）；
     `dsh-llm-deepseek/lib/index.js:1398-1401` = `off/low/high/max`。
   - `dsh-agent-loop/lib/index.js:713-752` —— effort 进 `seedConfig`（优先级：agent options > 会话持久化的
     requestHeader），生效值落 `request/header` 会话事件——**档位观测点与 P8 同一**。
2. 实测（`results/p9.log`，GLM-5.3-flash）：
   - `resolveModelInfo('zai-coding-cn', 'GLM-5.3-flash')` → `reasoning = undefined`（无目录），
     `context.contextWindow = 1000000` ✓（与 settings.yaml 声明一致）。
   - 注入 `reasoningEffort:'low'` 未落地（`request/header` 无 change 事件）——与 P8 未定项同源（同一改写机制），
     不影响上表的机制结论；若 P8 的官方路径走通，effort 随 `selectModel` 的 `reasoningEffort` 参数一并下发即可。
3. web UI 佐证：`dsh-client-ui-model-selection` 包（dsh-web-app 依赖）即生产模型+档位选择器，档位列表来自
   模型目录——「无目录不显示」是宿主自身的 UI 契约。

**降级预案：** 5b 档位列表数据源 = `resolveModelInfo(provider, model).reasoning`（插件内直读，无需新探针）；
`reasoning` 为空 → 控件隐藏（本机 GLM-5.3-flash 现状即隐藏）；非空 → 弹层选档、切换随 P8 官方路径下发。
**本机首版预期形态：🧠 控件隐藏**，不阻塞盾牌与 ◐ 控件，文档记录即可。

## 对阶段 5b 的影响

1. **◐ 上下文控件**：真控件。占用% = `contextPressure.pressureTokens / contextPressure.contextWindow`
   （投影直读）；缓存命中率与明细来自 SSE 流上 `assistant/message.usage`；点击展开可用
   `contextBreakdown`（system/tools/messages）与 `tokenMeter.measure()`。
2. **cube 模型控件**：弹层模型目录 = `llm.listProviders()` + `llm.listModels(provider)`；当前模型 =
   `session.requestHeader()` / `request/context` 事件；切换 = `sessionController.selectModel`（5b 冒烟确认可达性），
   并明示「将同步设为全局默认」或采用只读降级。
3. **🧠 思考档位**：`resolveModelInfo().reasoning` 为空 → 隐藏；非空 → 弹层选档随 selectModel 下发。
4. **盾牌（无需探针项）**不受影响；P8 的 `model/selection` 事件与 P7 的 usage 均经既有 SSE 转发到达手机端，
   无需新增通道。
5. 待 5b 在 web 实例完成的一行冒烟：`ctx.get('sessionController')` 可达性（headless 不挂载属预期）。

---

# 优化任务 A · 探针结论（P10）

> 生成：2026-09-03。探针插件在 `probe/plugin10/`（mobile-remote-probe10），原始输出在
> `probe/results/p10.log`（gitignore）。运行环境与命令见 `probe/README.md` 的 P10 节。
> 宿主包版本：dsh 全家桶 0.1.2-alpha.1（同 P7–P9）。

## P10 创建会话 API —— 证实

**结论：** DSH 有官方创建会话 API：**`ctx.get('sessionController').create({cwd | workspaceId, sessionId?, agentPreset?})`**
（dsh-api-session-controller，web 组合挂载，即生产 web UI「新建会话」按钮的后端）。
由插件直调**实测成功**：返回 `{sessionId}`，新会话立即进入 live 注册表（`sessions.list()`、
`agents.get(sid)`、`sessionQuery.listSessions()` 三路核对一致），发出 `session/created` 事件，
并且**全新空闲会话（从未有过轮次）可被既有 steer 路径唤醒出首轮**——`createUserMessage(source plugin)`
+ `agent.steer(msg)` 实测 5 秒内产出 assistant/message + turn/end。**优3「新建会话」判定为可做**，
完整复用现有绑定/steer 链路，零新增宿主依赖。

**证据：**

1. 源码（`dsh-api-session-controller/lib/index.js`）：
   - `:2435` `_create_decorators = [Remote("create")]` —— SessionController 服务面暴露 create；
     服务名 `sessionController`（`:2660` `super(ctx, "sessionController", { namespace: "session" })`），
     web 组合由 `dsh-web-app/cordis.patch.yml` 以行 `- id: session-controller` 插入（与 P8 selectModel 同一服务）。
   - `:576-601` `create(request)`：「Create or idempotently adopt one ordinary Session」——
     接受 `{sessionId?, workspaceId? | cwd?, agentPreset?}`（二者互斥）→ `agents.ensureSession(sessionId, cwd, …)`
     → workspace.attachSession（如给 workspaceId）→ 返回 `{sessionId, agentPreset?}`；错误词汇
     bad-request / workspace-not-found / workspace-attach-failed / internal。
   - `:993` 构造时挂 `ctx.on("session/created")` → `api-session/added`（桌面列表感知新建的机制）。
   - headless 组合不挂该包（P8 已记）；探针组合由插件 patch 补插
     `workspace` + `session-controller` 两行（与 web patch 同名同包）后激活成功——证明该服务
     不依赖 web 传输面，插件侧 `ctx.get` 直调成立。
2. 实测（`results/p10.log`，headless probe10 profile，真实 create + 真实 steer 一轮）：
   - `sessionControllerMounted: true`，`hasCreate: true`，`hasCommandsCreate: true`；
   - `sc.create({cwd: '…probe/workspace'})` → `{sessionId: "session-2b1cac5b-…"}`（**无需预生成 sessionId**）；
   - `session/created` 事件实测发出（cwd 正确落到请求的目录）；
   - live 核对：`sessions.list()` 含新会话 ✓；`agents.get(sid)` 可达且 `session.header.cwd` 一致 ✓；
     `sessionQuery.listSessions()` 记录 `{live: true, persisted: false}` ✓；
   - steer 唤醒：`agent.steer(createUserMessage(source:{kind:'plugin',plugin:'mobile-remote-probe10'}))`
     → 5 秒内 `user/message`(seq 7/8) → `assistant/message`(seq 152) → `turn/end` → agent/status idle ✓。
     决策 10 的「真人输入优先」不受影响：steer 的 plugin 来源不会把新会话误判为电脑当前会话
     （humanAt 只认 `source.kind==='user'`），新建会话的绑定走显式 pinnedSid（决策 13）。
3. 对优3 的落地路径：`+` → `sessionController.create({cwd: 当前绑定会话的 cwd})` →
   `bindSession + pinnedSid = 新 sid`（复用 /switch 同款语义）→ 手机发首条消息走既有
   `/send` → `agents.get(sid).steer`（本探针 D 项已实测该链路对全新会话成立）。
   降级：运行时 `ctx.get('sessionController')` 缺失或 create 抛错 → 手机端返回错误提示、
   `+` 按钮保留但报错（不静默失败）；服务在启动时探测缺失则整个隐藏 `+`。

**降级预案：** 探针结论为证实，无需。若未来宿主移除该服务/改签名：启动探测 `typeof sc?.create === 'function'`
不成立即隐藏 `+`，时间线与其余功能不受影响（P10 未定不阻塞交付的护栏在实现里同样成立）。
