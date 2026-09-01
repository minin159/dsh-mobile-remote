# mobile-remote — DSH 单会话远程控制

手机扫码/开链接 → 远程控制当前 DSH 会话：实时看流、发消息、审批权限请求。
完全独立的 DSH Cordis 插件，不对接、不依赖 phone-push。

当前版本：**1.0.0（阶段 1 MVP：单会话远程控制）**。路线图见 `docs/roadmap.md`。

## 功能（MVP）

| 功能 | 说明 |
|---|---|
| 配对入口 | DSH 设置页「移动端远程」：开关、双地址、二维码、复制链接、重置配对码 |
| 实时看流 | 会话增量（消息/工具/回合）+ 运行状态，聊天气泡渲染，滚动跟随 |
| 手机发消息 | 输入框 → `agent.steer`，带 `source:{kind:'plugin',plugin:'mobile-remote'}` 来源标记 |
| 手机审批 | 顶部审批条：允许/拒绝即终局（电脑端 GUI 不再弹）；超时（默认 120s）回落电脑端 |
| 安全 | token 即密码（日志打码、timingSafeEqual 校验）；单连接绑定，新连接顶替并通知；「停止远程」一键断开 |
| 断线恢复 | 环形缓冲（200 条）+ `?since=` 游标补发；安卓整页重载为主恢复路径（P5 实测） |

不做（阶段 2+）：会话列表与切换、状态标签打磨、过期重配对、审计 JSONL、公网 relay、Bot Channel。

## 安装（web 组合）

1. profile 依赖加入本仓库（link 形式即可）：

   ```jsonc
   // C:\Users\<你>\.dsh\profiles\web\package.json
   {
     "dependencies": { "mobile-remote": "link:D:/dsh-plugins/mobile-remote" },
     "dsh": { "profile": { "bundles": [ "…", "mobile-remote" ] } }
   }
   ```

2. `node_modules/mobile-remote` 指到本仓库（junction 即可，无需管理员）：

   ```sh
   cmd //c mklink /J "C:\Users\<你>\.dsh\profiles\web\node_modules\mobile-remote" "D:\dsh-plugins\mobile-remote"
   ```

3. **启动 DSH web（默认方式即可）**——DSH 出于安全封禁 `--host 0.0.0.0`，web 本体只绑回环：

   ```sh
   dsh web
   ```

   手机可达性由插件内置**路径过滤中继**承担：启用远程后插件自动监听
   `0.0.0.0:3090`（可在设置页调整）并转发到 `127.0.0.1:3080`，只放行
   `/mobile-remote/*` 路径，DSH 本体不暴露到局域网。设置页会自动给出
   `http://<局域网IP>:3090/mobile-remote/p/<token>` 形式的手机地址与二维码。

4. 打开 DSH 设置页 →「移动端远程」→ 打开开关 → 手机扫码。

## 手机审批语义（混合回落，探针 P3 实测）

- 手机点「允许」→ 工具继续；点「拒绝」→ 工具中止；**插件决策即终局，电脑端 GUI 不再弹窗**。
- 手机未在等待窗（默认 120s，可调 30s–300s）内应答 → 自动交回电脑端 GUI 决定（fail-safe 到人）。
- 手机断开超过 10s 宽限期（覆盖息屏整页重载）→ 挂起审批同样回落电脑端。
- `mobile_remote_selftest` 模型工具：让会话「跑一次审批自测」即可验证全链路（三条路径）。

## 安全模型

- 配对码为随机 32 位 hex，只在配对 URL / 查询参数 / 请求体中出现，日志一律打码；
  校验走 SHA-256 + `timingSafeEqual`，无长度短路。
- 单连接绑定：第二台设备连入会顶替第一台，旧页面收到 `replaced` 事件并停止自动重连。
- 设置接口（`/mobile-remote/api`）仅限电脑回环访问（Host + Origin 双校验）；手机侧只有
  携配对码的三个端点（页面/SSE/发送/审批）。
- 「停止远程」断开所有手机连接并使挂起审批立即回落电脑端；「重置配对码」使全部旧链接失效。
- 停用（默认）时：不拦截审批、不转发事件、页面返回 503，对 DSH 零影响。

## 目录

```
├── index.js      后端：路由 / SSE / 会话绑定 / steer / 审批拦截 / 安全
├── client.js     DSH 设置页（内联 vendored qrcode-generator，MIT）
├── web/page.html 移动端单页（零构建 vanilla JS + EventSource，内联样式与脚本）
├── docs/         roadmap（唯一事实源）/ 各阶段规格 / 探针结论
└── probe/        阶段 0 探针代码（不进发布）
```

## 已知边界（MVP 有意取舍）

- 只镜像「最近活跃的根会话」；多会话列表与手动切换在阶段 2。
- 助手消息超长时手机端显示增量文本（chunk 完整），最终消息帧超过 16KB 只保留收尾标记。
- Tailscale 地址形态已支持（publicBase 填 100.x 地址即可），出门场景首次使用前建议补测。
