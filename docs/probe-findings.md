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
