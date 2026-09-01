# 阶段 0 · 技术探针

前置：无。预算 8–15 万 token。本任务只做探针与文档，不实现正式功能。

## 目标

用最小代价实测 6 个未知项，把阶段 1 的技术选型从「推断」变成「证实」。所有结论写入
`docs/probe-findings.md`，每项给三态结论：**证实 / 证伪 / 未定** + 证据（代码位置、实测输出）。
探不明的一律写降级方案，禁止硬赌。

## 探针清单

### P1 webServer 能力（决定通道与页面托管形态）
- 方法：注册实验路由，测 ① 能否前缀/多路径注册（`{kind:'prefix'}` 或多次 exact）；
  ② 能否升级/托管 WebSocket；③ 返回 HTML/静态内容的方式与 Content-Type 控制。
- 证实：WS 可用 → 通道用 WS，页面静态托管。
- 证伪：降级 SSE（`EventSource`）+ POST 轮询；HTML 由 JS 模板字符串内联返回。

### P2 agent.steer 持续对话
- 方法：不经武装窗口，连续多次（间隔 1s / 10s / 空闲后）`agent.steer(createUserMessage(...))`，
  观察：是否入队执行、空闲会话是否被唤醒、有无频控或报错。
- 结论决定 MVP 是否「随时可发消息」；若受限，记录限制并设计节流。

### P3 approval/request 拦截语义
- 方法：注册 handler，对一次真实工具请求分别返回 'allowed-once' 与 'rejected'，
  观察 ① 工具是否真实放行/拒绝；② 电脑端 GUI 是否仍弹确认；③ 超时不响应时 DSH 默认行为。
- 结论决定手机审批交互形态（混合回落 vs 全接管）。

### P4 会话枚举与标识
- 方法：从 Cordis 上下文/事件探查能否拿到「当前会话 id」与多会话列表（判定阶段 2 的
  切换会话是否可做）；`session/event` 是否自带会话标识。
- 未定 → 阶段 2 的切换功能标记为「依 P4 结论」，MVP 只绑当前会话。

### P5 手机端连通性（需用户手机配合，提前列动作清单）
- 方法：起一个最小 HTTP 服务，分别用局域网 IP 与 Tailscale 地址在手机浏览器打开，
  测页面加载、EventSource/WS 建连、息屏唤醒后的恢复时延。
- 结论决定双地址默认值与重连参数。

### P6 二维码呈现
- 方法：验证设置页 client.js（platform:'web'）里渲染二维码的可行方式：内置小型 QR 生成
  逻辑（建议内联一个 MIT 的 QR 生成实现，无运行时依赖）或服务端返回 SVG。
- 结论决定「扫码入口」落在哪（设置页按钮 + 复制链接兜底）。

## 规则

- 探针代码全部放 `probe/`，带 `// probe` 标记，不打包、不注册正式设置项。
- 只读参考 `D:\dsh-plugins\phone-push\`（源码 + docs/roadmap.md 的运行时清单），禁止 import。
- 开工时 `git init` 并首次提交（docs + probe），结束打 tag `phase-0-done`。

## 完成标准

1. `probe-findings.md` 六项全有三态结论与证据；
2. 依据 P1/P3 结论修订 `phase-1-spec.md`（通道选型、审批形态）；
3. `roadmap.md` 阶段总表标记阶段 0 完成；
4. commit + tag。
