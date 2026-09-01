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

## 阶段 3 · 可选项（仅在用户点名时使用）

公网 relay（自备服务器与域名，+15–25 万 token）或 Bot Channel 入口。需要时再让我起草对应规格，不预置提示词。
