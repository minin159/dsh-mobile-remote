# 各阶段启动提示词（开新 ZCode 任务，整段粘贴即用）

> 用法：点「新任务」→ 复制对应阶段的提示词全文粘贴 → 发送。
> 每个提示词自包含，新任务无需本会话任何上下文。

---

## 阶段 0 · 技术探针

```text
任务：为 DSH（DeepSeek Harness，Cordis 框架宿主）的新插件 mobile-remote 完成阶段 0「技术探针」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（项目唯一事实源，含 DSH 运行时清单）
2. D:\dsh-plugins\mobile-remote\docs\phase-0-spec.md（本任务规格：探针 P1–P6）

硬约束：
- mobile-remote 是完全独立的 DSH Cordis 插件：禁止 import/依赖 phone-push，禁止共用其配置、审计、状态文件。phone-push 仓库（D:\dsh-plugins\phone-push）只允许只读参考其 DSH 运行时用法。
- 本任务只写探针代码（放 probe/ 目录，带 // probe 标记）与文档，不实现任何正式功能；不改 DSH 本体。
- 每个探针项结论必须三态（证实/证伪/未定）并附证据（代码位置/实测输出），探不明写降级方案，禁止硬赌。
- 代码注释用中文；conventional commits；不主动 push 远程。

步骤：
1. git init 并首次提交现有 docs。
2. 逐项完成 P1–P6（P5 需要我手机配合：先列出我需要在手机上做的动作清单，逐项触发）。
3. 全部结论写入 docs/probe-findings.md。
4. 依据 P1/P3 结论修订 docs/phase-1-spec.md 的通道选型与审批形态。
5. roadmap.md 阶段总表标记阶段 0 完成。

完成标准：probe-findings.md 六项全有结论；phase-1-spec 已修订；commit + tag phase-0-done。
预算提示：约 8–15 万 token，超支先停下降范围并汇报。
```

---

## 阶段 1 · MVP（探针完成后使用）

```text
任务：为 DSH 新插件 mobile-remote 实现阶段 1「MVP：单会话远程控制」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（唯一事实源 + DSH 运行时清单）
2. D:\dsh-plugins\mobile-remote\docs\phase-1-spec.md（本任务规格）
3. D:\dsh-plugins\mobile-remote\docs\probe-findings.md（阶段 0 实测结论：通道选型、审批形态、连通性参数以此为准）

硬约束：
- 独立插件，零依赖 phone-push（不 import、不共用配置/审计/状态文件）；phone-push 仓库仅只读参考。
- 前端零构建：web/ 单页 vanilla JS + fetch + EventSource/WS，资源本地化，不引 CDN。
- 通道与审批形态严格按 probe-findings.md 的实测结论实现，不重新选型。
- token 即密码：URL 之外不落日志全文；单连接绑定，新连接顶替并提示。
- 代码注释中文；conventional commits；不主动 push。

实现范围：phase-1-spec.md 全部六项（配对入口/页面通道/看流/发消息/审批/安全）。
其中手机审批默认混合回落：超时（默认 120s）回落电脑端 GUI 决定。

验收（先列出我手机上要做的动作清单，再逐项触发）：phase-1-spec.md 的验收清单七项全过。
电脑端回归：不开远程时插件零影响。

交付：版本 1.0.0 + CHANGELOG；roadmap.md 打勾；commit + tag phase-1-done。
止损：审批若在本阶段证伪，缩范围到「看流 + 发消息」先交付，把审批挪到阶段 2，并在 roadmap.md 风险节记录。
预算提示：约 25–40 万 token。
```

---

## 阶段 2 · 完整对齐（MVP 验收后使用）

```text
任务：为 DSH 插件 mobile-remote 实现阶段 2「完整对齐 ZCode 功能面」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md
2. D:\dsh-plugins\mobile-remote\docs\phase-2-spec.md（本任务规格；每项独立 commit，开始前先问我要裁剪哪些项）
3. docs/probe-findings.md（P4 会话枚举结论决定切换功能的形态）

硬约束：
- 独立插件，零依赖 phone-push；不做云 relay、不做 Bot Channel（阶段 3 用户点名才做）。
- 代码注释中文；conventional commits；不主动 push。

范围：phase-2-spec.md 六项（会话列表与切换/状态标签/配对健壮性与过期重配对/审计 JSONL/恢复加固/UI 打磨）。

验收（需我手机配合，先列清单）：列表切换、状态刷新、过期重配对、审计文件可回溯；电脑端不开远程零影响回归。

交付：版本 1.1.0 + CHANGELOG；roadmap.md 打勾；commit + tag phase-2-done。
预算提示：约 20–35 万 token，按裁剪后范围浮动。
```

---

## 阶段 4 · UI 2.0（当前可执行）

```text
任务：为 DSH 插件 mobile-remote 实现阶段 4「UI 2.0：首页工作区卡片 + 会话视图对齐 ZCode」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（唯一事实源 + DSH 运行时清单）
2. D:\dsh-plugins\mobile-remote\docs\phase-4-spec.md（本任务规格，含视觉基准说明）
3. docs/probe-findings.md（P4：sessions.list()/sessionQuery 带 cwd 与标题快照）

硬约束：
- 本阶段 90% 工作在 web/page.html，后端仅给 /mobile-remote/sessions 补 cwd 与最近活动时间。
- 范围排除：底栏五键（盾牌/上下文/模型/思考强度 → 阶段 5）、附件、主题切换、新建会话、云 relay、Bot Channel；禁止 import phone-push（注释级参考允许）。
- 所有 markdown/代码渲染必须受控 DOM 构建（textContent），与阶段 2 代码块同防注入标准。
- 代码注释中文；conventional commits；不主动 push。

实现范围：phase-4-spec.md 全部——首页工作区卡片长列表（cwd 分组/折叠/汇总行/说明卡）、
任务行（标题+相对时间+四态胶囊+点击进入）、会话视图（顶栏返回、表格与行内代码渲染、
流式"当前动作"toast、↓FAB）、底部输入栏保持现状不动。

验收（真机，与阶段 2 欠账六项合并为一次手机配合，先列清单再逐项触发）：
- 阶段 2 六项：列表切换/状态刷新/过期重配对/审计回溯/息屏恢复/停用零影响回归
- 本阶段：首页分组与折叠正确、30+ 会话长列表流畅、表格/代码渲染无注入、
  toast 与 FAB 行为、返回导航不丢绑定与滚动位置

交付：版本 1.2.0 + CHANGELOG；roadmap 打勾；commit + tag phase-4-done。
止损：部分会话无 cwd → 归入「未分组」卡片，不阻塞交付。
预算提示：约 15–25 万 token。
```

---

## 阶段 5a · 底栏控件探针（可与阶段 4 并行）

```text
任务：为 DSH 插件 mobile-remote 完成阶段 5a「底栏控件探针 P7–P9」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
背景：本任务可与阶段 4（UI 2.0）并行执行——两者文件面零重叠。阶段 4 任务可能正在同一仓库工作，务必遵守下面的隔离约束。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（唯一事实源 + DSH 运行时清单）
2. D:\dsh-plugins\mobile-remote\docs\phase-5-spec.md（探针项定义在「探针（任务 5a）」节）
3. docs/probe-findings.md（已有 P1–P6 结论，本任务只在其末尾追加 P7–P9）

探针项：
- P7 上下文用量/缓存命中：session 事件流（turn/end、agent/status 等）与宿主包是否携带 token 用量/上下文占用/缓存命中数据
- P8 运行时切换模型：DSH 是否有 per-session/运行时模型切换接口（查宿主包 dsh-llm/agent-loop 源码 + probe profile 实测）
- P9 思考强度档位：harness 是否暴露 per-session/per-message 思考档位

硬约束（并行隔离）：
- 只允许改动 probe/（新增探针脚本）与 docs/probe-findings.md（末尾追加）；禁止改动 index.js/client.js/web/、roadmap.md、phase-5-spec.md——阶段 4 正在改它们。
- git 提交只 `git add probe/ docs/probe-findings.md`，禁止 `git add -A`/`git add .`，防止把阶段 4 的半成品收进提交。
- 探针用独立 headless probe profile（照 phase-0 的 probe/plugin 方式装配），不碰用户正在用的 DSH web 实例，不需要手机配合。
- 每项三态结论（证实/证伪/未定）+ 证据（宿主包源码行号/实测输出）；探不明如实写未定并给降级建议（隐藏/只读），禁止硬赌。
- 代码注释中文；conventional commits；不主动 push。

完成标准：probe-findings.md 追加 P7–P9 三态结论；commit + tag phase-5a-done。
预算提示：约 3–6 万 token。
```

---

## 阶段 5b · 底栏控件实现（阶段 4 与 5a 都完成后执行）

```text
任务：为 DSH 插件 mobile-remote 实现阶段 5b「底栏运行时控件实现」。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
前置确认：阶段 4 已完成（v1.2.0，tag phase-4-done）且阶段 5a 探针已完成（tag phase-5a-done）；任一未完成则立即停止并汇报，不得开工。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md
2. D:\dsh-plugins\mobile-remote\docs\phase-5-spec.md
3. docs/probe-findings.md 的 P7–P9 节（控件形态以此为准：证实=真控件；证伪/未定=按规格降级为隐藏或只读）

硬约束：
- 底栏布局按 phase-5-spec：盾牌（权限模式）· 上下文/缓存 · 模型 · 思考强度 · ↑发送；附件与调色板明确不做。
- 盾牌三档（手机审批/全部放行/全部拒绝）是无需探针的确定项，直接实现；「全部放行」页面红色警示条常驻；
  档位为会话级临时状态、重启回到手机审批；每次切换写审计 JSONL；设置页同步显示当前模式。
- 禁止 import phone-push；代码注释中文；conventional commits；不主动 push。

验收（真机，先列清单再逐项触发）：盾牌三档各实测一条审批路径（放行/拒绝/回落）+ 审计可回溯 +
设置页模式同步；P7–P9 对应控件逐个实测（真控件）或确认降级形态；停用回归零影响。

交付：版本 1.3.0 + CHANGELOG；roadmap 阶段 5 打勾（注明 5a/5b 拆分执行）；commit + tag phase-5-done。
预算提示：约 5–15 万 token（探针已在 5a 完成）。
```

---

## 阶段 3 · 可选项（仅在用户点名时使用）

公网 relay（自备服务器与域名，+15–25 万 token）或 Bot Channel 入口。需要时再让我起草对应规格，不预置提示词。
