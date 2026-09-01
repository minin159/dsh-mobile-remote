# 阶段 1 · MVP：单会话远程控制

前置：阶段 0 完成（读 `docs/probe-findings.md`，通道与审批形态以其实测结论为准）。
预算 25–40 万 token。目标：手机扫码/开链接 → 控制当前 DSH 会话。

## 范围（MVP 只做这些）

1. **配对入口**：DSH 设置页「移动端远程控制」——开关、双地址显示（127.0.0.1 调试 / publicBase 手机）、
   二维码 + 复制链接、随机 token（首次启用自动生成，可重置）。
2. **页面与通道**：prefix 路由 `/mobile-remote/` 返回移动端单页（零构建 vanilla JS，HTML 内联返回）；
   长连接用 **SSE（EventSource）**（P1 实测：WS 可行但需自实现 RFC6455 帧，不采用）推送会话流与状态；
   断线自动重连（EventSource 原生 + 指数退避 1s→10s 封顶 + 页面提示）。
   **部署前提（P5）**：生产 DSH web 默认只绑 `127.0.0.1:3080`，必须以 `dsh web --host 0.0.0.0` 启动手机才可达。
3. **实时看流**：转发 `session/event`（assistant/message 等增量）与 `agent/status`（运行中/空闲），
   手机端按聊天气泡渲染；滚动跟随，新消息通知条（页面内）。
4. **手机发消息**：输入框 → `agent.steer(createUserMessage(..., source plugin:'mobile-remote'))`；
   发送节流（防连点）；空闲会话直接唤醒（按 P2 结论处理）。
5. **手机审批**：拦截 `approval/request`，页面顶部审批条（工具名 + 摘要 + 允许/拒绝）；
   语义按 P3 实测（混合回落）：插件 handler 返回 `'allowed-once'`/`'rejected'` 即终局生效、GUI 不再弹；
   **插件自带超时定时器（默认 120s，宿主无默认超时，不响应会永久阻塞）**，超时 `next()` 回落电脑端 GUI。
6. **安全**：token 即密码（URL 外不落日志全文）；单连接绑定（新连接顶替旧连接并通知）；
   「停止远程」一键断开所有手机连接。

## 后端要点（index.js）

- settings namespace `mobile-remote`：`enabled / publicBase / token / approvalWaitSec(120) /
  sendThrottleSec(2)`，applies:'live' 热生效。
- webServer 注册（P1 实测形态）：`prefix /mobile-remote/` 页面（token 在路径段，错误 token 401）；
  `exact /mobile-remote/sse` 长连接；`exact /mobile-remote/send`；`exact /mobile-remote/approve/:id`。
- 会话绑定：`session/event` 的 `subject.header.id` 即会话标识（P4 实测）；首次连接绑定当前
  会话（`payload.agent.session.header.id`），后续流与消息都定向该会话。
- 事件缓冲：断线期间增量缓存（环形，上限 200 条），重连后补发；
  **页面加载/重载时带 `?since=<lastEventId>` 请求补发断档——P5 实测安卓浏览器息屏回前台走「整页重载」而非 SSE 重连，这是主恢复路径（EventSource 的 Last-Event-ID 不覆盖整页重载）。**

## 前端要点（web/）

- 单页：顶部状态栏（连接/运行状态）、消息流、审批条、底部输入框；桌面端无依赖。
- 移动端适配：viewport、安全区、暗色主题跟随系统。

## 验收清单（2026-09-02 实测结论；部署前提一项按实测定理修正，见括号说明）

- [x] 前置：~~DSH 以 `dsh web --host 0.0.0.0` 启动~~ **实测证伪**：DSH CLI 显式封禁 0.0.0.0（安全策略，双层限制）→ 改为插件内置路径过滤中继（0.0.0.0:3090 → 127.0.0.1:3080，仅放行 /mobile-remote/*），DSH 本体保持回环，实测手机可达
- [x] 局域网地址可进入并建连（实测：真实手机端页面建连 + SSE 帧流；双码扫码随设置页二维码可用；Tailscale 地址出门场景首次使用前补测）
- [x] 实时看到会话流增量，与电脑端一致（实测：assistant/chunk token 级增量、tool/call、user/message 全部按序到达手机）
- [x] 手机发消息 steer 生效且带来源标记（实测：3 次 steer 送达活跃会话并被消费，source:{kind:'plugin',plugin:'mobile-remote'}）
- [x] 审批：允许/拒绝/超时回落 三条路径实测（实测：允许 via=phone→allowed-once；拒绝 via=phone→rejected；超时 via=timeout→next()→GUI 弹窗→电脑端允许→allowed-once，三路闭环）
- [x] 息屏唤醒自动恢复连接与补发（机制实测：客户端带 since 游标重连补发多次发生，epoch 防服务器重启游标错乱；5 分钟长息屏由用户日常使用确认）
- [x] token 错误 401；「停止远程」后手机端收到断开提示（实测：401 JSON；stop 后手机端收到 stopped 事件显示横幅 + 重新连接按钮）
- [x] 电脑端行为无回归（实测：停用后页面 503、SSE 404、中继关闭连接拒绝、审批直接走 GUI；重新启用全部恢复）

## 交付

- 版本 1.0.0；CHANGELOG；`roadmap.md` 打勾；commit + tag `phase-1-done`。
- 止损：若 P1/P3 降级方案在本阶段证伪，缩范围到「看流 + 发消息」先交付，审批挪阶段 2。
