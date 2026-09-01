# Changelog

## 1.0.0 (2026-09-02)

阶段 1 · MVP：单会话远程控制。首个发布版本。

### 新增

- **配对入口**：DSH 设置页「移动端远程」——开关、双地址显示（电脑回环调试 / 手机访问）、
  客户端 canvas 二维码（vendored MIT qrcode-generator，零依赖）、复制链接、
  重置配对码（旧链接立即失效）、停止远程。
- **页面与通道**：`/mobile-remote/p/<token>` prefix 路由内联返回移动端单页
  （零构建 vanilla JS + EventSource，本地资源、暗色跟随系统、安全区适配）；
  SSE 长连接 + POST 控制接口（P1 探针选型）；断线指数退避重连 1s→10s。
- **实时看流**：转发 `session/event`（user/message、assistant/chunk 流式增量、
  assistant/message、tool/call、tool/result、回合边界、审批审计）与 `agent/status`；
  聊天气泡渲染、滚动跟随、新消息提示条。
- **手机发消息**：`agent.steer` 带 `source:{kind:'plugin',plugin:'mobile-remote'}` 来源标记；
  服务端 + 页面双端发送节流（默认 2s，防连点，非宿主限制）。
- **手机审批**：拦截 `approval/request`，页面审批条（工具名+摘要+倒计时）；
  允许/拒绝即终局（P3 实测：GUI 不再弹）；插件自带超时（默认 120s，宿主无默认超时）
  到点 `next()` 回落电脑端 GUI；手机断开 10s 宽限后同样回落；
  `mobile_remote_selftest` 诊断工具用于自测三条审批路径。
- **安全**：token 即密码（随机 32 位 hex、日志打码、timingSafeEqual）；
  单连接绑定（新连接顶替并通知旧端）；设置接口仅限电脑回环，且在中继层二次封禁；
  环形缓冲（200 条/会话）+ `?since=` 游标补发（P5 实测：安卓息屏回前台走整页重载，
  该路径为主恢复链路）。
- 断点续传游标带服务器启动纪元（epoch），DSH 重启后页面自动重置游标，避免永久漏发。
- 会话绑定只认真人键盘输入（`user/message` 且 `source.kind==='user'`）——失败重试循环
  的会话事件流会永久霸占"最近活跃"绑定（实测踩坑），插件 steer 与后台事件不参与判定。

### 修正（相对阶段 0 规格的实测变更）

- **部署前提**：`dsh web --host 0.0.0.0` 被 DSH CLI 显式封禁（安全策略：避免把整个
  Agent 座舱暴露到网络；webserver config schema 亦只允许回环/0.0.0.0）。改为插件内置
  **路径过滤反向代理**：默认 `0.0.0.0:3090 → 127.0.0.1:3080`，仅放行 `/mobile-remote/*`，
  DSH 本体保持回环——比整站暴露更安全，手机地址由设置页自动给出。
- 审批等待窗可调档位为 30 秒/1/2/5 分钟（默认 120 秒），超时回落电脑端 GUI。

### 部署前提

- DSH web 正常启动即可（本体保持回环 127.0.0.1:3080）；手机可达性由插件中继承担，
  首次启用若被 Windows 防火墙拦截需放行 node 入站（局域网）。
