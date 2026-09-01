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
| 0 探针 | webServer 路由/长连接能力、steer 持续对话、审批语义、会话枚举、手机连通性、二维码呈现 | 8–15 万 | probe-findings.md 六项三态结论 + phase-1-spec 修订 |
| 1 MVP | 单会话远程控制：扫码/链接进入、实时看流、手机发消息、y/n 审批、断线自动恢复 | 25–40 万 | 手机端逐项实测清单通过 |
| 2 完整对齐 | 会话列表与切换、状态标签、踢出/过期/重配对、审计 JSONL、恢复加固与 UI 打磨 | 20–35 万 | 对齐 ZCode 功能面 |
| 3 可选 | 公网 relay（需服务器）/ Bot Channel 类入口 | 15–25 万 | 用户点名才做 |

总计 53–90 万 token（约占 3 亿额度 0.02%–0.03%）。每阶段独立验收、独立 commit + tag，随时可停不留半成品。

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
8. **工程约定**：代码注释中文；conventional commits（feat:/fix:/docs:）；不主动 push 远程（远程仓库是否建立由用户决定）。

## DSH 运行时清单（写适配代码的事实依据，沿用 phone-push 已验证结论）

- `inject: ['timer','tools']`；`ctx.timeout(ms)` 返回 Promise。
- 服务：`ctx.get('jobs').onJobDone(cb)`、`ctx.get('subprocess').spawn/resolveExecutable`、
  `ctx.inject(['settings'])`（namespace 'mobile-remote'，schemastery schema，applies:'live'）、
  `ctx.inject(['webServer'])`（register 路由；能否前缀/静态托管 → 探针 P1）。
- 事件：`approval/request`（async (req,next) → 'allowed-once'/'rejected' 或 next()）、
  `session/event`（assistant/message 流）、`agent/status`（running/idle）、
  `agent/error`（30s 跨会话去抖经验）、`subagent/end`、`agent/inbox/inserted`。
- steer：`@deepseek-ai/dsh-llm` 的 `createUserMessage({content:[{type:'text',text}],source:{kind:'plugin',plugin:'mobile-remote'}})` → `agent.steer(msg)`。
- 工具注册：`ctx.tools.register({name,description,parameters,output:{schema,render},execute})`。

## 风险与对策

- webServer 不支持 WS/前缀路由 → 降级 SSE + 轮询，页面由 JS 内联返回（P1 先行定选型）。
- steer 持续对话有频控/副作用 → 探针 P2 实测，必要时加发送节流与确认。
- 手机批准后电脑端仍弹 GUI → 产品语义定为「混合回落」，文档如实记录差异。
- 手机连通性（Tailscale 唤醒时延、休眠）→ P5 实测；长连接断线自动重连为硬要求。
- 测试需要用户手机配合：每阶段验收列出手机动作清单。

## 仓库约定

- 目录 `D:\dsh-plugins\mobile-remote`；阶段 0 任务开工时 `git init` 并首次提交（含本 docs）。
- 版本：MVP 完成 → 1.0.0；完整对齐 → 1.1.0。
- 用户配置（token/publicBase）只在用户层设置，不入库；日志不打印 token 全文。
