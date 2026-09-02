# mobile-remote 全局路线图（唯一事实源）

> 跨任务的唯一事实源。每个阶段的执行任务开工前先读本文件 + 对应阶段规格 + `docs/probe-findings.md`（阶段 0 之后）。
> 各阶段启动提示词见 `docs/task-prompts.md`（开新任务粘贴即用）。

## 背景与目标

对标 ZCode 桌面端的「移动端远程控制」（内部名 webRemoteControl）：**扫码或在手机上打开链接，即可远程控制当前工作区**——手机上实时看会话流、发消息、审批权限请求、查看/切换工作区与会话。

为 DeepSeek Harness (DSH) 做一个**完全独立**的等价插件 `mobile-remote`。**不对接、不依赖 phone-push**（不 import、不共用配置/审计/状态文件），仅允许参考其源码中已验证的 DSH 运行时用法。

## 对标功能拆解（来自 app.asar 逆向，2026-09-01）

ZCode 原版 = 三层云架构：

```
桌面端(Electron) ──WS──▶ ZCode 官方云 relay(/ws) ──▶ 手机浏览器（官方托管页面 /remote/<配对码>）
```

- 手机端是桌面窗口的**同步镜像视图**：已打开的项目/任务/会话列表、按工作区/时间线整理、切换工作区、会话状态（运行中/空闲/完成/错误）。
- 配对语义：单链接单会话、重复占用互踢（sessionConflict/kicked）、会话过期需桌面端重新生成、桌面断开即中断。
- 另有 Bot Channel（飞书/Telegram/微信）作为长时间访问替代入口（本项目不做）。

**本项目的核心降维决策：砍掉云 relay 层，改局域网 + Tailscale 直连。** 用户已有双地址基础设施与自建服务经验，无需公网服务器与云端配对。

## 总架构

```
mobile-remote（DSH Cordis 插件，独立目录 D:\dsh-plugins\mobile-remote）
├── index.js      后端：webServer 挂载 /mobile-remote/（移动端页面 + 长连接 + 控制API）
│                 配对(token即密码) · 会话流转发(session/event) · agent.steer 收消息
│                 approval/request 拦截审批 · agent/status 状态
├── client.js     DSH 设置页：开关 / 双地址(publicBase) / 显示二维码 / 重新配对
├── web/          移动端单页应用（零构建，vanilla JS + fetch + EventSource，本地内联资源）
└── probe/        仅阶段 0 的探针代码（不进发布）
```

## 阶段总表

| 阶段 | 内容 | 预算(token) | 验收 |
|---|---|---|---|
| 0 探针 ✅ | webServer 路由/长连接能力、steer 持续对话、审批语义、会话枚举、手机连通性、二维码呈现 | 8–15 万 | probe-findings.md 六项三态结论 + phase-1-spec 修订（2026-09-02 完成，tag `phase-0-done`；六项均证实，P5 已回填真机数据） |
| 1 MVP ✅ | 单会话远程控制：扫码/链接进入、实时看流、手机发消息、y/n 审批、断线自动恢复 | 25–40 万 | 验收八项全部有结论（2026-09-02，tag `phase-1-done`）：全路由 curl 通过；真实手机端实测 看流/steer/审批允许/审批拒绝/停止远程提示/断线重连+游标补发；超时回落经 GUI 弹窗应答闭环；停用回归（页面 503/SSE 404/中继关闭）通过 |
| 2 完整对齐 ✅ | 会话列表与切换、状态标签、踢出/过期/重配对、审计 JSONL、恢复加固与 UI 打磨 | 20–35 万 | 六项全部实现（2026-09-02，tag `phase-2-done`，六项独立 commit）：列表切换/四态标签/过期重配对/审计 JSONL/恢复加固/UI 打磨；语法与路由自检通过，真机验收清单待手机配合回填（列表切换、状态刷新、过期重配对、审计回溯、息屏恢复、停用零影响回归） |
| 4 UI 2.0 ✅ | 首页工作区卡片（cwd 分组）+ 会话视图对齐（表格/toast/FAB）；**不含底栏控件** | 15–25 万 | 实现+自检完成（2026-09-02，tag `phase-4-done`）：首页 cwd 分组卡片/折叠持久化/汇总行/说明卡/任务行、会话视图表格+行内代码（受控 DOM 防注入）/「当前动作」pill/↓FAB/双视图滚动保持与重载视图记忆；后端仅 /sessions 补 lastAt。冒烟 27 项 + 阶段 2 回归 26 项通过，浏览器 mock 实测（分组/折叠/渲染/往返滚动/pill/FAB）通过；真机验收清单待手机配合回填（合并阶段 2 欠账六项 + 本阶段五项） |
| 5 底栏控件 ✅ | 盾牌权限模式 + 上下文缓存/模型/思考强度；**5a 探针收尾已并入 5b 一个任务执行**（先探针后实现，探不明降级） | 8–20 万 | 实现+自检完成（2026-09-02，tag `phase-5a-done` + `phase-5-done`）：P7–P9 探针三态结论存档（P7 证实/P8 官方路径证实+自改写未定/P9 机制证实但本机模型无档位目录）；盾牌三档（手机审批/全部放行/全部拒绝）+ 红色警示条 + 会话级临时态 + 切换审计 + 设置页同步；◐ 上下文/缓存只读展示（P7 最小形态）；模型/思考键隐藏（P8/P9 降级存档）；冒烟 phase5 19 项 + phase2 26 项 + phase4 27 项通过。真机验收清单待手机配合回填：盾牌三档审批路径实测、◐ 降级形态确认、阶段 2 欠账六项（列表切换/状态刷新/过期重配对/审计回溯/息屏恢复/停用零影响回归）+ 阶段 4 五项（首页分组/折叠、长列表滚动、表格代码渲染无注入、toast 与 FAB、往返导航状态保持）、Tailscale 连通性补测 |
| 优化A 入口与会话组织 ✅ | 桌面一键出码（优1）+ 时间线视图与新建会话（优3）；前置探针 P10 | 15–22 万 | 实现+自检完成（2026-09-03，tag `opt1-done` + `opt3-done`，v1.4.0）：P10 证实 `sessionController.create` + steer 可唤醒全新会话（probe-findings.md P10 节，探针 `probe/plugin10/`）；pair_qr 工具 + `/qr.svg` 回环路由（三层呈现）；首页「按工作区/按时间线」分段切换（纯前端）；「＋新建」按钮（canNew 运行时探测显隐）+ `/new` 自动钉住；smoke phase2 26 + phase4 42 + phase5 19 全绿。真机验收清单待手机配合回填：pair_qr 出码扫码进、时间线切换数据一致、新建后发首条消息成功、停用零影响回归 |
| 优化B 会话控制 | 优2 模型切换真控件 + 优4 多设备观察者模式；**优4 用户暂缓**（已实现部分存 `opt4-wip` 分支） | 计划 25–35 万；优2 实际约 8–10 万 | 优2 实现+自检完成（2026-09-03，tag `opt2-done`，v1.5.0）：底栏 🧊 弹层（目录 = 官方 llm 服务、能力探测显隐）+ 切换只走官方 `sessionController.selectModel`（P8 唯一证实路径）+ 审计 `model_switch`（含 from/to/失败）；smoke-opt2 19 项 + phase2/4/5 回归全绿。真机验收待回填：手机切模型 → 电脑端确认下回合生效 + 审计可查 + 停用零影响。优4：多连接角色/接管/30s 冷却/clid 同页恢复/ctlKey 守卫/审批只推主控已实现且 smoke-opt4 29 项过，叫停时 phase5 回归段未改完、真机未做，现场见 `opt4-wip` |
| 优化C 内容层 Apple 化 ✅ | 优6 移动端页面 Apple 皮肤化（风格 E · iOS 黑灰，对齐 App 壳）；**纯 CSS 换皮零逻辑改动**（不动事件/协议/SSE、不改 DOM 结构与 class 命名、不碰 index.js/client.js） | 目标 10–18 万（实际约 12–14 万，未超红线） | 实现+自检完成（2026-09-03，tag `opt6-done`，v1.6.0）：设计令牌整体替换（#050506/#141416/#1F1F23、次级灰 #98989E、分割线 #222226·#26262A、白底黑字主强调、功能色仅绿 #30D158 红 #FF453A）+ SF/PingFang 字体栈（修掉按钮不继承字体）；首页 iOS 26px 大标题 + inset grouped 工作区卡片 + segmented 分段；会话视图 AI 无边框纯文本 #ECECF0 / 用户 #2C2C2E 气泡右对齐 / 表格与代码块圆角卡片化；审批条 50px·12px 圆角按钮重绘；FAB/pill/toast/顶栏/输入栏毛玻璃；底栏盾牌/模型键 SF 细线条图标（CSS mask 内联 SVG + emoji 回退），键位与 ↑/aria 契约不变；冒烟 phase2 26 + phase4 42 + phase5 19 + opt2 19 = 106 项全绿；前后对比图 `docs/compare-opt6-{before,after}.png`。真机验收清单待手机配合回填（并入「大验收 + 整改」）：三屏与壳一体无跳色、长列表滚动流畅、暗色一致性、停用零影响回归 |
| 3 可选 | 公网 relay（需服务器）/ Bot Channel 类入口 | 15–25 万 | 用户点名才做 |

总计 76–135 万 token（约占 3 亿额度 0.03%–0.05%）。每阶段独立验收、独立 commit + tag，随时可停不留半成品。

## 执行模式

- 每阶段开一个新 ZCode 任务（用户点「新任务」+ 粘贴 `docs/task-prompts.md` 里的提示词）。
- 新任务开工第一步：读本文件 + 对应阶段规格（+ probe-findings.md）+ 现有源码，不做重复推导。
- 需要用户手机配合的验收项，执行任务先列清单再逐项触发。

## 关键决策记录（不再重新推导）

1. **零依赖 phone-push**：用户明确要求独立。仅参考其源码与 `D:\dsh-plugins\phone-push\docs\roadmap.md` 中的「DSH 运行时清单」事实。
2. **通道 = 局域网 + Tailscale 双地址**（URL 随机 token 即密码，本机回环用于电脑侧调试，publicBase 供手机访问）；不做云 relay，不引入公网面。
3. **前端零构建**：web/ 单页 vanilla JS，静态资源本地内联/同目录托管，不引 CDN（LAN 环境）。
4. **配对语义对齐 ZCode**：单连接绑定当前会话；换设备/过期需在电脑端重新生成；提供「停止远程」开关。
5. **审批语义 = 混合回落**：手机批准放行 / 拒绝拦截，超时回落电脑端 GUI 确认（fail-safe 到人）。以探针 P3 实测为准。
6. **steer 来源标记**：手机消息一律 `source:{kind:'plugin',plugin:'mobile-remote'}`，便于区分与后续审计。
7. **运行时**：Windows，node v24 在 PATH；DSH 为 Cordis 宿主（运行时事实见下节清单）。
8. **工程约定**：代码注释中文；conventional commits（feat:/fix:/docs:）；远程 `github.com/minin159/dsh-mobile-remote`（Private，2026-09-02 建立作备份），每阶段 tag 后 push 一次。
9. **部署 = 插件内置路径过滤中继**（阶段 1 实测修正）：DSH web CLI 显式封禁 `--host 0.0.0.0`（dsh-web-app startup.js 安全检查），webserver config schema 也只允许 `127.0.0.1|0.0.0.0`——宿主设计意图是 web 本体不出回环。mobile-remote 自带反向代理（默认 0.0.0.0:3090 → 127.0.0.1:3080，仅放行 /mobile-remote/*，设置接口在中继层显式封禁），比整站暴露更安全。P5 的 `dsh web --host 0.0.0.0` 前提据此作废。
10. **会话绑定 = 真人输入优先**（阶段 1 实测修正）：`pickSession` 只认 `user/message` 且 `source.kind==='user'` 的事件（真人键盘输入）作为"当前会话"信号，其次会话创建时间；不用"最近事件活跃"——失败重试循环的会话事件流不断，实测会永久霸占绑定并误收 steer。
11. **审批共存**：phone-push 也在监听 approval/request（waterfall 顺序 = bundle 注册顺序，phone-push 先答）。ntfy 在线时同一审批会双通道推送（ntfy 卡片 + 手机页面审批条），先答者终局、后答者 404——功能不冲突但提示会重复；ntfy 离线时 phone-push 自动回落，单通道无感。手机审批条上的 id 与 ntfy 卡片无关联，属预期。
12. **转发策略（阶段 2）**：enabled 期间所有根会话事件入各自环形缓冲（16×200 有界，子代理不入），绑定会话额外直发；切换/重连按连接级游标（cursorBySid）补发——切换后不空白、切回不重复。环形缓冲无连接时也记（enabled 前提下），整页重载补发覆盖离线窗口。
13. **手机钉住语义（阶段 2）**：手动切换的会话（pinnedSid）跨重连/整页重载保持，自动挑选（决策 10）只在无钉住时生效；停止远程/重置配对码清除钉住。
14. **状态四态映射（阶段 2，启发式）**：running→运行中；idle 且上一回合 `turn/end` reason.kind==='completed'→完成；其余 idle→空闲；`agent/error`→错误（真人新输入或新一轮运行清除）。宿主无独立 done 语义，「完成」是推断值。
15. **配对有效期（阶段 2）**：tokenIssuedAt + pairTtlHours（默认 72h，0=不过期）；过期对齐 ZCode 语义（电脑端重新生成）；`/paircheck` 供页面在 SSE 断开后判失效原因（EventSource 拿不到 HTTP 状态码）。
16. **审计（阶段 2）**：`~/.dsh/mobile-remote-audit.jsonl` 默认开、设置页可关；只记元数据（动作/时间/会话/来源/耗时/长度）不记正文，token 不落盘；写失败本轮停用，超 5MB 轮转 .old。停用插件零写入。
17. **盾牌 = 会话级临时权限档（阶段 5）**：三档 ask/allow-all/deny-all 仅存内存（重启/停止远程回手机审批），不落 settings；代答只在「插件启用 + 手机在线 + 绑定会话」三前提齐时生效（fail-safe 回落电脑端 GUI）；每次切换与每次代答都写审计（`shield_mode` / `approval_decide via=shield-*`）；P8/P9 控件本轮降级隐藏（探针结论见 probe-findings.md，完整实现按需再开），P7 只做只读展示。
18. **新建会话 = 官方 create + 立即钉住（优化A，P10 证实）**：`sessionController.create({cwd})`（与 P8 selectModel 同服务，web 组合挂载；headless 不挂载属预期）；cwd 沿用当前绑定会话目录（不做工作区选择）；创建即 `bindSession` + `pinnedSid`（决策 13 钉住语义不变），首条消息走既有 steer——全新空闲会话实测可唤醒出首轮；能力**运行时探测**（`/sessions` 报 `canNew`，页面据此显隐＋按钮），宿主缺失返回 501 如实报错，不阻塞其余功能。
19. **pair_qr 三层呈现（优化A）**：桌面 GUI 工具卡片只渲染 pre 文本（trajectory 渲染源码实查，附件图仅限 attachment 管线），故出码分三层——markdown 图片行指向回环 `/mobile-remote/qr.svg?token=`（绝对 http 地址过 GUI sanitizer，渲染为大尺寸二维码）+ 完整链接文本 + 等宽 ASCII 兜底；配对链接全文随会话日志落盘为既定取舍（与设置页展示同级别，日志不出本机）。
20. **模型切换只走官方路径（优化B/优2，P8）**：弹层目录 = `llm.listProviders()`+`listModels()`（条目防御归一 `{id,name}`）；当前模型 = `session.requestHeader().config`，读不到即前端显示「跟随默认」；切换 = `sessionController.selectModel({sessionId,provider,model})`——自实现 `agent/request` waterfall 改写 P8 三轮实测未落地，**禁止依赖**；官方副作用「同步保存为电脑端默认模型」接受并在弹层明示；能力运行时探测（`/sessions` 报 `canModel`），宿主缺失即隐藏键 + 501，不阻塞其余功能。
21. **优4 多设备观察者模式暂缓（优化B/优4，2026-09-03 用户叫停）**：已实现部分（新连接默认观察者、1 主控 + ≤3 观察者有界、接管 + 30s 冷却、clid 同页恢复护住 P5 息屏重载主路径、connKey 控制接口守卫、审批只推主控护住决策 11、observer_join/leave/takeover 审计）保留在 `opt4-wip` 分支（smoke-opt4 29 项过；smoke-phase5 回归段未按新语义改完、真机未验）；恢复实施时从该分支续做，不重推导。

## DSH 运行时清单（写适配代码的事实依据，沿用 phone-push 已验证结论）

- `inject: ['timer','tools']`；`ctx.timeout(ms)` 返回 Promise。
- 服务：`ctx.get('jobs').onJobDone(cb)`、`ctx.get('subprocess').spawn/resolveExecutable`、
  `ctx.inject(['settings'])`（namespace 'mobile-remote'，schemastery schema，applies:'live'）、
  `ctx.inject(['webServer'])`（register 路由；**P1 实测：exact+prefix 均可、registerUpgrade 可做 WS（原始 socket 归插件）、SSE/Content-Type 自由控制；阶段 1 选 SSE**）、
  `ctx.get('sessions').list()`（live 会话）与 `ctx.get('sessionQuery').listSessions()`（全量含持久化，newest-first）——**P4 实测**。
- 事件：`approval/request`（async (req,next) → 'allowed-once'/'rejected' 或 next()；
  **P3 实测：插件决策即终局、GUI 不再弹；宿主无默认超时，插件必须自带（默认 120s→next()），挂起会永久阻塞（abort→cancelled）**）、
  `session/event`（assistant/message 流；subject.header.id 即会话标识，P4 实测）、`agent/status`（running/idle）、
  `agent/error`（30s 跨会话去抖经验）、`subagent/end`、`agent/inbox/inserted`。
- steer：`@deepseek-ai/dsh-llm` 的 `createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:'mobile-remote'}})` → `agent.steer(msg)`。
  **P2 实测：无需武装、无频控、1s/10s 间隔连发全部入队消费；空闲唤醒是 agent-loop 一等路径（idle 时 wakeDriver 开新轮）。**
- 工具注册：`ctx.tools.register({name,description,parameters,output:{schema,render},execute})`。
- **部署前提（P5）**：生产 DSH web 默认 `127.0.0.1:3080`，手机可达需 `dsh web --host 0.0.0.0` 启动。

## 风险与对策

- ~~webServer 不支持 WS/前缀路由 → 降级 SSE + 轮询~~ **P1 已实测：prefix 路由与 WS 均可用；选型定为 SSE + POST（WS 需自实现帧，不采用）。**
- steer 持续对话有频控/副作用 → **P2 已实测：无频控、无武装要求**；发送节流保留为 UI 防连点（2s）。
- 手机批准后电脑端仍弹 GUI → **P3 已实测：插件决策即终局，GUI 不弹**；「混合回落」语义保留，超时由插件自实现。
- 手机连通性（Tailscale 唤醒时延、休眠）→ **P5 局域网侧已实测通过**（微信 WebView/Edge 建连 31–183ms、RTT ~25ms）；安卓息屏回前台走整页重载 → 阶段 1 按 `?since=<lastEventId>` 补发设计；Tailscale 侧出门场景补测。
- ~~生产 DSH 默认只绑回环~~ → **阶段 1 已解决（决策 9）**：DSH 封禁 0.0.0.0，插件内置路径过滤中继（默认 3090 端口）承担手机可达性；中继端口可在设置页调整。Tailscale 场景把 publicBase 设为 100.x:3090 即可，出门首次使用前建议补测一次连通。
- **绑定被"僵尸活跃"会话霸占** → 阶段 1 实测踩坑并修复（决策 10）：重试循环会话事件不断，曾把测试 steer 误送进用户在用会话；已改为只认真人输入。
- **审批多插件共存双推送** → 已记录（决策 11）：与 phone-push 并存时同一审批可能双通道提示，先答终局；后续阶段可考虑探测共存并让位。
- 测试需要用户手机配合：每阶段验收列出手机动作清单。

## 仓库约定

- 目录 `D:\dsh-plugins\mobile-remote`；阶段 0 任务开工时 `git init` 并首次提交（含本 docs）。
- 版本：MVP 完成 → 1.0.0；完整对齐 → 1.1.0。
- 用户配置（token/publicBase）只在用户层设置，不入库；日志不打印 token 全文。
