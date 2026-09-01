# probe/ — 技术探针（阶段 0 / 阶段 5a）

> 全部文件带 `// probe` 标记，只做实测，不进发布包。结论汇总见 `docs/probe-findings.md`。

## 内容

| 文件 | 探针 | 运行方式 |
|---|---|---|
| `p1-webserver.mjs` | P1 webServer 能力（路由/前缀/WS/SSE/Content-Type） | `node probe/p1-webserver.mjs` |
| `p6-qr.mjs` | P6 二维码生成（内联 MIT 库，服务端 SVG） | `node probe/p6-qr.mjs` |
| `p6-qrcode-generator.js` | vendored MIT 实现（Kazuhiko Arase，MIT，头保留） | 被 p5/p6 引用 |
| `p5-server.mjs` | P5 手机连通性（HTTP+SSE，0.0.0.0:18790，页面含 P6 双码） | `node probe/p5-server.mjs` |
| `plugin/` | P2/P3/P4 探针插件（mobile-remote-probe） | 见下 |
| `plugin5a/` | P7/P8/P9 探针插件（mobile-remote-probe5a，阶段 5a） | 见下 |
| `results/` | 实测原始输出（p1-result.json、p3-*.log、p2.log、p5-*.log/jsonl、p7/p8*/p9*.log） | gitignore，不入库 |

## 探针插件运行环境（P2/P3/P4）

独立 DSH profile（不碰 web/desktop，验收后可删）：

- `C:\Users\lq\.dsh\profiles\probe\package.json` — bundles: `dsh-base` + `dsh-headless` + `mobile-remote-probe`
- `probe\node_modules\mobile-remote-probe` — junction 指回本仓库 `probe/plugin/`

```sh
# P4 会话枚举
cd probe/workspace
MOBILE_REMOTE_PROBE_MODE=p4 MOBILE_REMOTE_PROBE_LOG=<绝对路径>\p4.log \
  node C:\Users\lq\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile probe "请调用 probe_p4 工具一次"

# P3 审批（MODE 取 p3-allow / p3-reject / p3-none / p3-hang）
MOBILE_REMOTE_PROBE_MODE=p3-allow ... --profile probe "请调用 probe_gate 工具一次"

# P2 steer
MOBILE_REMOTE_PROBE_MODE=p2 ... --profile probe "请调用 probe_p2 工具一次"
```

## 阶段 5a 探针插件运行环境（P7/P8/P9）

独立 DSH profile（不碰 web/desktop，验收后可整目录删除）：

- `C:\Users\lq\.dsh\profiles\probe5a\package.json` — bundles: `dsh-base` + `dsh-headless` + `mobile-remote-probe5a`
- `probe5a\node_modules\mobile-remote-probe5a` — junction 指回本仓库 `probe/plugin5a/`

```sh
cd probe/workspace
# P7 上下文用量/缓存命中
MR_PROBE5A_MODE=p7 MR_PROBE5A_LOG=<绝对路径>\p7.log \
  node C:\Users\lq\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js --profile probe5a "请调用 probe_p7 工具一次，然后只回复 P7-DONE。"

# P8 切模型（TARGET 换成 listModels 里的任意模型）
MR_PROBE5A_MODE=p8 MR_PROBE5A_TARGET_MODEL=GLM-4.7-Flash [MR_PROBE5A_REWRITE=veto] ... "请调用 probe_p8 工具一次，然后只回复 P8-DONE。"

# P9 思考档位（TARGET_EFFORT 取 off/minimal/low/medium/high/xhigh/max/clear）
MR_PROBE5A_MODE=p9 MR_PROBE5A_TARGET_EFFORT=low ... "请调用 probe_p9 工具一次，然后只回复 P9-DONE。"
```

## P5 手机动作清单（验收时逐项触发）

服务：`node probe/p5-server.mjs`（后台），地址见 `results/p5-urls.txt`。
清单原文见 `docs/probe-findings.md` 的 P5 节。

## 阶段 2 冒烟测试（smoke-phase2.mjs）

mock Cordis ctx 装载插件本体（无需 DSH 宿主），逐路由回归阶段 2 链路：
页面/配对（含过期）/sessions/switch/SSE 补发/状态帧/send 全链路（stub dsh-llm）/
审计 JSONL/停用零影响。运行：

```sh
node probe/smoke-phase2.mjs   # 期望 26 PASS / 0 FAIL
```

阶段 3 开工前先跑一遍，确认基线未破坏。
