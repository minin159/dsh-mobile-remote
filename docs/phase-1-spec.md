# 阶段 1 · MVP：单会话远程控制

前置：阶段 0 完成（读 `docs/probe-findings.md`，通道与审批形态以其实测结论为准）。
预算 25–40 万 token。目标：手机扫码/开链接 → 控制当前 DSH 会话。

## 范围（MVP 只做这些）

1. **配对入口**：DSH 设置页「移动端远程控制」——开关、双地址显示（127.0.0.1 调试 / publicBase 手机）、
   二维码 + 复制链接、随机 token（首次启用自动生成，可重置）。
2. **页面与通道**：`/mobile-remote/<token>` 返回移动端单页（零构建 vanilla JS）；长连接
   （WS 或 SSE，按 P1 结论）推送会话流与状态；断线自动重连（指数退避 + 页面提示）。
3. **实时看流**：转发 `session/event`（assistant/message 等增量）与 `agent/status`（运行中/空闲），
   手机端按聊天气泡渲染；滚动跟随，新消息通知条（页面内）。
4. **手机发消息**：输入框 → `agent.steer(createUserMessage(..., source plugin:'mobile-remote'))`；
   发送节流（防连点）；空闲会话直接唤醒（按 P2 结论处理）。
5. **手机审批**：拦截 `approval/request`，页面顶部审批条（工具名 + 摘要 + 允许/拒绝）；
   语义按 P3 结论：默认混合回落——手机不响应超时（默认 120s）→ 电脑端 GUI 决定。
6. **安全**：token 即密码（URL 外不落日志全文）；单连接绑定（新连接顶替旧连接并通知）；
   「停止远程」一键断开所有手机连接。

## 后端要点（index.js）

- settings namespace `mobile-remote`：`enabled / publicBase / token / approvalWaitSec(120) /
  sendThrottleSec(2)`，applies:'live' 热生效。
- webServer 注册（形态依 P1）：`GET /mobile-remote/<token>` 页面；`/stream` 长连接；
  `POST /send`；`POST /approve/:id`。
- 会话绑定：首次连接时绑定当前会话 id，后续流与消息都定向该会话。
- 事件缓冲：断线期间增量缓存（环形，上限 200 条），重连后补发。

## 前端要点（web/）

- 单页：顶部状态栏（连接/运行状态）、消息流、审批条、底部输入框；桌面端无依赖。
- 移动端适配：viewport、安全区、暗色主题跟随系统。

## 验收清单（需用户手机配合，先列清单再逐项触发）

- [ ] 局域网与 Tailscale 两地址均可扫码进入并建连
- [ ] 实时看到会话流增量，与电脑端一致
- [ ] 手机发消息 steer 生效且带来源标记
- [ ] 审批：允许/拒绝/超时回落 三条路径实测
- [ ] 息屏 5 分钟后唤醒自动恢复连接与补发
- [ ] token 错误 401；「停止远程」后手机端收到断开提示
- [ ] 电脑端行为无回归（不开远程时插件零影响）

## 交付

- 版本 1.0.0；CHANGELOG；`roadmap.md` 打勾；commit + tag `phase-1-done`。
- 止损：若 P1/P3 降级方案在本阶段证伪，缩范围到「看流 + 发消息」先交付，审批挪阶段 2。
