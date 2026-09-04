# 优化任务（合并版 · 两大任务）

> 原 5 项合并为 2 个大任务（优5 静音开关已剔除——手动关 ntfy 审批通道即可替代）。
> **前置硬条件：v1.3.0 大验收已完成**，否则验收 fix 会与本任务改动搅在同一批文件里。
> 执行顺序：先任务 A（入口层，便宜）→ 再任务 B（控制层，贵）。两项内部各自独立
> commit + tag，中途停下也留干净现场。通用护栏：红线内每步自检；功能迭代 ≤2 轮；
> 同一问题重试 ≤2 次，超线即停汇报；零耦合 phone-push；中文注释；conventional commits。

---

## 大任务 A · 入口与会话组织（优1 + 优3，目标 15–22 万，红线 22 万）

```text
任务：为 DSH 插件 mobile-remote 实现「入口与会话组织」双功能——桌面一键二维码入口（优1）+ 时间线视图与新建会话（优3）。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
前置确认：v1.3.0 大验收已完成（若未完成，停下向用户确认是否继续）。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（唯一事实源 + DSH 运行时清单）
2. docs/probe-findings.md（P4 会话枚举、P6 二维码逻辑复用）
3. docs/phase-4-spec.md（首页工作区卡片现状）

第一步 · 探针 P10：DSH 是否有创建会话的 API/service（agent.create 或等价物）。
三态结论 + 证据写入 probe-findings.md 追加节；未定/证伪则"+"按钮隐藏，不阻塞其余交付。

第二步 · 优1 桌面一键出码：
- ctx.tools.register 注册工具 pair_qr：调用即在会话内渲染大尺寸二维码卡片
  （复用 P6 内联 qrcode-generator 逻辑），附完整链接文本。
- 不做系统托盘、桌面快捷方式；设置页现有二维码不动。→ commit + tag opt1-done

第三步 · 优3 时间线视图 + 新建会话：
- 时间线：首页顶部「按工作区 / 按时间线」分段切换，纯前端重排现有 listSessions 数据
  （按最近活动排序、按天分组），后端零改动。
- 新建会话：仅当 P10 证实才做"+"——新建后自动切入并钉住；否则隐藏按钮。
- 不做搜索/筛选/会话归档删除。→ 时间线 commit；新建会话 commit + tag opt3-done

护栏（硬约束）：红线 22 万 token；先优1 后优3 顺序实施减少同文件冲突；P10 未定不得阻塞
时间线交付；功能迭代各 ≤2 轮；同一问题重试 ≤2 次；超线立即停下汇报进度与剩余项。

验收（真机）：工具出码手机扫码可进；时间线切换数据一致；新建会话（若做）手机发首条消息成功；
停用零影响回归。
交付：版本 1.4.0 + CHANGELOG + roadmap 更新；tags opt1-done、opt3-done。
预算提示：目标 15–22 万 token。
```

---

## 大任务 B · 会话控制能力（优2 + 优4，目标 25–35 万，红线 30 万）

```text
任务：为 DSH 插件 mobile-remote 实现「会话控制能力」双功能——模型切换真控件（优2）+ 多设备观察者模式（优4）。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
前置确认：大任务 A 已完成（v1.4.0）；未完成则停下汇报。

开工必读（按序）：
1. D:\dsh-plugins\mobile-remote\docs\roadmap.md（决策 13 钉住语义、决策 11 审批共存）
2. docs/probe-findings.md 的 P8 节（官方切换路径已证实——只走官方路径，自实现禁止尝试）

第一步 · 优2 模型切换真控件：
- 底栏模型键从隐藏改为弹层：列出官方接口支持的模型集；点选即对绑定会话生效。
- 不做自定义模型名输入、不做批量/多会话生效、不做模型参数编辑。
- 每次切换写审计 JSONL；能读到会话上次模型则恢复，读不到跟随默认。
→ commit + tag opt2-done

第二步 · 优4 多设备观察者模式：
- 新连接默认「观察者」：只读看流（审批条/输入框隐藏，状态条标"观察中"）；无主控时
  可点「接管主控」升级；主控断开 30s 后任意观察者可接管。
- 观察者不可发消息/审批/切换绑定；"新连接顶替"语义只作用于主控位，
  不得破坏钉住语义（决策 13）与"审批只有一个主控应答"原则（决策 11）。
- 审计记 observer_join/leave/takeover；观察者上限 3（有界）。
- 不做观察者间通信、不做更细权限分级。
→ commit + tag opt4-done

护栏（硬约束）：红线 30 万 token；两项分开实施分开 commit，任何一项超线即停并保留已完成项；
功能迭代各 ≤2 轮；同一问题重试 ≤2 次；顶替/接管逻辑改动后必须回归钉住与审批路径。

验收（真机）：手机切模型 → 电脑端确认下回合生效 + 审计可查；两设备实测观察者只读、
接管生效、主控审批仅主控端出现；停用零影响回归。
交付：版本 1.5.0 + CHANGELOG + roadmap 更新；tags opt2-done、opt4-done。
预算提示：目标 25–35 万 token。
```

---

## 已剔除

- **优5 审批提示静音开关**：手动关闭 phone-push 的 ntfy 审批推送通道即可替代（保留其完成/失败推送）。若以后想要自动化开关再起草。

---

## 大任务 C1 · 真机反馈修复 + 优4 复工（五项，基于 v1.6.0，目标 25–40 万，红线 35 万）

> 来源：用户真机使用 v1.6.0（风格 E 换皮后）的反馈（2026-09-03 截图）四条 + 用户点名优4 复工。
> C2 换皮已完成（opt6-done）；优4 此前按用户指示暂缓，WIP 现场完整保留在 `opt4-wip` 分支
> （14 文件、含 270 行 smoke-opt4.mjs），本任务接手续做并合入。完成后进入大验收。

```text
任务：为 DSH 插件 mobile-remote 修复四条真机反馈。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
开工必读：docs/roadmap.md（决策 12/13：环形缓冲与游标补发、钉住语义）+ docs/probe-findings.md（P4：sessionQuery.readSession 存在性）。

四条修复（按此顺序，各独立 commit）：
1. fix(new-session): 新建会话默认工作区改 D 盘
   /new 的 create({cwd}) 从「沿用当前绑定会话 cwd」（index.js:1553 注释处）改为默认
   'D:\'（常量 DEFAULTS.newSessionCwd）。收紧：本轮不做设置页配置项。
2. feat(thinking): 思考过程可折叠块
   现状：reasoning-delta 只显示「🤔 思考中…」一行提示，思考文本未渲染（page.html:617/702）。
   改为：流式期间提示行升级为可折叠块——展开可见实时思考文本（累积追加，展开态才自动滚底）；
   assistant/message 定稿后思考块保留为收起态（显示行数/字数摘要，点击展开）。
   定稿消息若带 reasoning 字段以其为准，否则保留流式累积内容。折叠态记忆存 localStorage。
   样式直接按当前 E 令牌做（页面已换皮 v1.6.0，无需占位）。
3. feat(history): 进入会话回读最近历史
   现状：进会话只回放环形缓冲（仅插件启用期间、200 帧上限），持久化历史从未接入。
   接入 sessionQuery.readSession：进入/切换会话时，若该会话环形缓冲为空或不足 30 条，
   从 readSession 拉最近 30 条消息渲染为历史区（顶部加「 历史 」分隔条标识），
   之后无缝衔接 live 流与游标补发（决策 12 语义不变）。readSession 返回载荷形状未知——
   先打印核实结构再写渲染（P4 只探了存在性）。读失败静默降级为现状（仅缓冲回放），不阻塞。
4. fix(scroll): APK 内消息显示不全、无法滑动（阻塞级，优先定位）
   #stream 的 overflow-y:auto + -webkit-overflow-scrolling 在手机浏览器正常，
   在 Android WebView 失效。定位手段：USB 连接 + chrome://inspect 远程调试
   （app 仓库 D:\dsh-plugins\mobile-remote-app 的 MainActivity WebView）。
   页面侧候选修复：html/body 由 height:100% 改 100dvh 或 position:fixed 布局、
   逐级核查 flex 高度链（html/body → #app → 会话视图 → #stream）。
   若根因在壳侧（WebView 设置/Activity 布局）：只产出最小 patch 说明（精确到文件与行），
   不直接改 app 仓库（跨仓库约束），交回主会话执行。

5. feat(observer): 优4 多设备观察者模式复工（接手 opt4-wip 分支）
   WIP 现场：git checkout opt4-wip 已含 14 文件改动（index.js +378 行、page.html +127 行、
   smoke-opt4.mjs 270 行三套冒烟同步更新）——先 rebase 到当前 main（v1.6.0 换皮已落地，
   冲突以 main 的 E 令牌样式为准解决），续完剩余语义：
   - 新连接默认「观察者」：只读看流（审批条/输入框隐藏，状态条标"观察中"）；
   - 无主控时可点「接管主控」升级；主控断开 30s 后任意观察者可接管；
   - 观察者不可发消息/审批/切换绑定；"新连接顶替"只作用于主控位；
   - 不破坏钉住语义（决策 13）与"审批单主控应答"（决策 11）；
   - 审计记 observer_join/leave/takeover；观察者上限 3（有界）。
   合入 main 前跑全量冒烟（phase2/4/5 + opt2 + opt4 全过）。
   commit：feat(observer): 多设备观察者模式（自 opt4-wip 复工合入）→ tag opt4-done

护栏：红线 35 万 token（含优4 复工）；五项各独立 commit，优4 在四条修复全部落地后
最后做（rebase 冲突面最大，放尾 minimize 返工）；同一问题重试 ≤2 次；第 4 条若两轮定位
仍无法确定根因，保留诊断数据停下汇报，禁止盲改；优4 若 rebase 冲突过大（>300 行手动
解决），停下评估改用「从 WIP 提取语义重写」路线。交付前全量冒烟必须全过。

验收（真机）：新建会话落在 D:\；思考块可展开/收起且定稿后保留；进会话可见历史并
无缝衔接新消息；APK 内长对话可滑动到底；浏览器端无回归；观察者模式用 手机 + 电脑
无痕窗（或两台设备）实测：观察者只读、接管生效、主控审批仅主控端出现。
交付：版本 1.7.0；roadmap 记录；tags c1-fixes-done + opt4-done。
预算提示：目标 25–40 万 token。
```

---

# C3 · 五条新需求（基于 v1.7.1 + 堆叠版，目标 15–25 万，红线 25 万）

> 来源：用户真机使用反馈（2026-09-05 截图对照 ZCode 移动端）。前置：DSH 已就地重启，
> v1.7.1 + 供应商堆叠已生效。视觉基准：D:\QQ.file\Screenshot_20260905_011432.jpg（ZCode 截图）。

```text
任务：为 DSH 插件 mobile-remote 实现五条新需求（视觉对齐 ZCode + 会话生命周期管理）。
工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
开工必读：docs/optimization-tasks.md 的 C1/C2 段（前两轮修复背景）+ docs/probe-findings.md。

关键 API 事实（已调研，sessionController 现成能力，勿重新推导）：
- sessionController.drop(sessionId)（dsh-api-session-controller/lib/client.js:1538）：
  从 live 注册表删除并触发清理（drainSessionDisposals）——删除会话/丢弃空会话共用此 API。
- create({cwd}) 建 / drop(sid) 删，二者已/将接入本插件（P10 已证实 create 路径）。

五条需求（每条独立 commit，按此顺序）：
1. style: 字号对齐 ZCode 移动端
   视觉基准：用户截图（ZCode）——正文基准从 15px 调至约 14px，标题/气泡/footnote 各层级
   等比收紧，列表行更密；具体取值以截图目测为准，允许 ±0.5px 微调，一轮内完成不许反复。
2. style: 底栏对齐 ZCode
   截图底栏特征：浅色调毛玻璃（半透明面板 + backdrop blur）、图标键无底色或极淡底色、
   无边框描边、整体扁平。改 #composer 与 .barBtn 的 CSS（E 令牌基础上调），布局与键位不动。
3. feat(thinking): 思考过程自动堆叠
   现状：每个 step 一个 thinkBlock（默认收起但各自独立成块）。
   改为：同一回合内多个思考块自动堆叠——收起态合并为一条紧凑摘要条（"思考 · N 段 · M 字"），
   只保留最新一条的可展开性；展开后按段落纵向排列。历史思考只保留摘要，不保留全文 DOM
   （流式期间全文照旧累积，定稿后瘦身）。localStorage 折叠偏好沿用。
4. feat(new-session): 空会话不存档
   /new 创建的会话，若用户从未发送消息（无任务运行）就离开/切换/断开——自动 drop 该会话
   （仅对"本插件 /new 创建且零输入"的会话生效，绝不动用户电脑端建的会话）；
   实现点：页面端记录 newCreatedSid，切换会话/回首页/关闭页面时若其消息数为 0 则
   POST /mobile-remote/drop；服务端校验"该会话确为本插件所建 + 无 user/message 事件"再调
   sessionController.drop，双端校验防误删。drop 失败静默（会话残留无害）。
5. feat(delete): 移动端删除会话
   会话行滑动露出红色删除按钮（iOS 滑动删除交互）或长按菜单（选易实现的）；
   点击后二次确认弹窗（居中小窗，同模型弹窗形态）→ POST /mobile-remote/delete {token,sid} →
   服务端 sessionController.drop(sid)。仅允许删除"persisted 但非当前绑定"的会话；
   live 运行中的会话禁删（按钮置灰 + 提示）。删除后列表即时移除 + toast。
   审计记 session_delete（含 sid，不含内容）。

护栏：红线 25 万 token；五条独立 commit；视觉两条（1/2）各一轮迭代不许反复；
同一问题重试 ≤2 次；drop/delete 路径必须先 mock 冒烟（新增 smoke-c3.mjs：空会话 drop、
删除确认、live 会话禁删三组断言）再真机；交付前全部旧冒烟（136 断言）+ 新增全过。

验收（真机）：字号/底栏与截图气质一致；多条思考堆叠成一条可展开摘要；新建不发言离开后
会话不出现；滑动/长按可删一条历史会话且二次确认生效；运行中会话禁删。
交付：版本 1.8.0；CHANGELOG；roadmap 记录；tag c3-features-done。
预算提示：目标 15–25 万 token。
```

---

## 大任务 C2 · 真机反馈修复轮 II（两条，基于 v1.7.0，目标 6–12 万，红线 12 万）

> 来源：用户真机使用 v1.7.0 的反馈（2026-09-03）。壳侧三问题（顶部小黑条/软键盘遮挡/
> E 配色对齐）已由主会话直接修复并重建 APK；本任务只修插件侧两条。完成后进入大验收。

```text
任务：为 DSH 插件 mobile-remote 修复两条真机反馈。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。
开工必读：docs/optimization-tasks.md 的 C1 段（v1.7.0 已修四条）+ docs/probe-findings.md P8/P10 节。

两条修复（各独立 commit）：
1. fix(new-session): 新建会话 EPERM——cwd 不能指向盘符根目录
   现状：NEW_SESSION_CWD = 'D:\'（index.js:89），DSH 创建会话时要在 cwd 下
   ensure project directory（mkdir），对盘符根目录 Windows 返回 EPERM
   （真机报错原文：failed to ensure project directory "D:" / EPERM mkdir 'D:\'）。
   改为：NEW_SESSION_CWD = 'D:\dsh-sessions'（固定子目录）；enabled 变 true 时若该目录
   不存在则 fs.mkdir recursive 创建一次，失败记日志不阻塞；/new 失败的返回信息带上
   目标目录路径便于定位。
2. feat(model-picker): 模型切换改小弹窗 + 列表可滑动
   现状：#modelSheet 是全宽底部大 sheet（page.html:312-334），真机反馈"还是有 bug"且
   要求小弹窗、可滑动选择。
   改为：居中小弹窗（宽 min(320px, 86vw)、圆角 14px、半透明遮罩点击关闭，不再全宽
   贴底）；模型列表区 max-height 40vh + overflow-y auto + -webkit-overflow-scrolling:
   touch；当前模型行高亮（描边/对勾）；条目 44px 高；点选后弹窗立即关闭并 toast 确认。
   E 风格令牌（--panel/--press/--sep）沿用，不引入新色。切换逻辑（POST selectModel）
   一律不动，只改交互形态。
   真机复测原"bug"：若切换本身仍失败（官方接口报错），把报错原文记入
   probe-findings.md 追加节再修——先区分"交互形态问题"与"接口问题"，禁止混为一谈。

护栏：红线 12 万 token；两条独立 commit；同一问题重试 ≤2 次；交付前全部冒烟
（133 断言）全过；模型切换若确认为官方接口侧问题，如实记录汇报，不硬绕。

验收（真机）：新建会话成功且落在 D:\dsh-sessions；模型弹窗为居中小窗、列表可滑动、
点选即切且下一回合生效。
交付：版本 1.7.1；roadmap 记录；tag c2-fixes-done。
预算提示：目标 6–12 万 token。
```

---

## 大任务 C2 · 内容层 Apple 化（原大任务 C，优6，目标 10–18 万，红线 15 万）

```text
任务：把 mobile-remote 移动端页面（web/page.html）按 Apple 风格重新皮肤化，与 App 壳（v3 灰）完全一体。工作目录 D:\dsh-plugins\mobile-remote。环境：Windows + Git Bash，node v24 在 PATH。

开工必读（按序）：
1. docs/roadmap.md（唯一事实源）
2. D:\dsh-plugins\mobile-remote-app\docs\ui-mockup-v5-ios-blackgray.png（视觉基准——风格 E 第五列，壳将对齐此稿）
3. docs/phase-4-spec.md / phase-5-spec.md（页面现有结构：首页工作区卡片、会话视图、底栏）

设计令牌（风格 E · iOS 黑灰，已定稿）：背景 #050506 / 卡片 #141416 / 次级面 #1F1F23 ·
正文 #F2F2F7 · 次级灰 #98989E · 分割线 #222226·#26262A · 主强调=白底黑字（运行中胶囊/发送键/
主按钮）· 用户气泡 #2C2C2E · 功能色仅开关绿 #30D158 与错误红 #FF453A · 字体栈
-apple-system / PingFang SC · 大标题 26px 粗体 · 按钮 50px 高 12px 圆角 · footnote 12.5px。

范围（收紧：只换皮，不换骨）：
- 全局：CSS 设计令牌替换（暗色为主，亮色简单适配）、SF 字体栈、卡片/圆角/分割线风格统一。
- 首页：工作区卡片 → iOS 分组列表形态（inset grouped、细分割线、chevron）；汇总行/说明卡同风格。
- 会话视图：气泡（用户 #2C2C2E 深灰右对齐、AI 无边框纯文本 #ECECF0）、代码块/表格圆角卡片化、
  审批条与盾牌警示条按 50px 按钮规格重绘、toast 与 FAB 苹果化（毛玻璃感可用半透明+模糊）。
- 底栏：五键图标风格统一为 SF 风格细线条，键位布局不变。
- 亮色模式：简单适配（#F2F2F7 底），不追求双主题打磨。

明确不做（硬边界）：不改任何事件逻辑/协议字段/SSE 处理；不改 DOM 结构（只动样式与
class 命名）；不做动效库/复杂动画；不碰 index.js/client.js 的业务逻辑。

护栏（硬约束）：红线 15 万 token；样式迭代最多两轮；改完后 probe/smoke-phase2/4/5 三套
冒烟必须全过（106 断言），任一断言失败须当场修复样式引用后才可交付；同一问题重试 ≤2 次；
超线即停汇报。

验收（真机，约 20 分钟）：三屏（首页/会话/底栏）与壳一体无跳色；长列表滚动流畅；
暗色一致性；冒烟三套全过；停用零影响回归。
交付：版本 1.6.0 + CHANGELOG + roadmap 更新 + 前后对比截图两张；commit + tag opt6-done。
预算提示：目标 10–18 万 token。
```

**执行顺序（2026-09-03 更新：优4 并入 C1）**：A ✅ → B（优2 ✅）→ C ✅（tag `opt6-done`，
v1.6.0，106 冒烟全绿）→ **C1 修复轮（四条真机反馈 + 优4 观察者复工，基于 v1.6.0，
接手 opt4-wip 分支续做合入）→ 大验收 + 整改（强制，不再顺延，含累计欠账 + C1 新增真机项）**。
C1 与大验收同仓库同文件，串行。
