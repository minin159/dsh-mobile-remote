# C1 · APK 内滚动失效：诊断与修复说明（fix 4）

> 2026-09-03。现象：APK（壳 WebView）内消息显示不全、无法滑动；同一页面在手机浏览器
> 正常。本文记录定位过程、页面侧已落地修复、以及壳侧（app 仓库）待执行的最小 patch。
> 跨仓库约束：mobile-remote 任务不改 mobile-remote-app 仓库，壳侧 patch 交回主会话执行。

## 一、根因分析（代码级 + 差异推断）

### 1. 页面高度链（page.html，修复前）

```
html, body { height: 100% }          ← 基准错误来源
body { display:flex; flex-direction:column }  （无 overflow 约束）
├─ #topbar / #homeTop  flex-shrink:0
├─ #homeView / #chatView  flex:1; min-height:0
│   └─ #stream  flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch
└─ #composer  flex-shrink:0
```

`height:100%` 的包含块是 **layout viewport**。浏览器 App（微信 WebView / Edge Android）
的 layout viewport 由浏览器自行扣除系统栏高度；而壳走 `SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
LAYOUT_HIDE_NAVIGATION`（沉浸式，MainActivity.kt:200-207），系统栏以悬浮层叠加，
**WebView 的视口 = 整块物理屏**。两差异叠加的结果：

- 在浏览器里：body 高度 ≈ 可视区，`#stream` 的 `flex:1` 分到正确高度，溢出 → `overflow-y:auto` 触发 → 可滚。
- 在壳里：body 高度 = 物理屏高（比可视区大出状态栏 + 导航栏 ≈ 90–130px），`#stream` 分到超视口
  高度 → 内容尾部落在「可视区之外但 body 之内」→ 看起来「显示不全」；同时 `#stream` 自身
  没有溢出（它拿到的高度足够容纳内容）→ **overflow-y 永不触发 → 无法滑动**。

这与真机反馈「显示不全 + 无法滑动」双症状完全吻合，且解释了「同一 URL 在浏览器正常」。

### 2. 壳侧布局核查（已读 MainActivity.kt + activity_main.xml + AndroidManifest.xml）

- WebView `match_parent` 直挂 FrameLayout（activity_main.xml:8-11）——**没有** ScrollView/嵌套
  滚动容器包裹，无 `wrap_content` 高度塌陷问题。壳布局本身不是主因。
- `domStorageEnabled = true`、`javaScriptEnabled = true`（MainActivity.kt:75-84）——localStorage、
  SSE 所需能力齐备。
- manifest activity **未声明 `android:windowSoftInputMode="adjustResize"`**（AndroidManifest.xml:19-20）：
  软键盘弹出时窗口不缩放 → 输入框/审批条可能被键盘遮住，是次要相关问题（非本条主因，见 patch 2）。

## 二、页面侧修复（本仓库已落地，v1.7.0）

1. **`100dvh` 基准**：`html, body { height:100% }` 之上以 `@supports (height:100dvh)` 升级为
   `100dvh`（动态视口高，跟随沉浸式布局的真实可视区）；老内核无 dvh 时自动回退 `100%`。
2. **`body { overflow:hidden }`**：滚动只允许发生在 `#stream`/`#homeView`（唯一滚动容器），
   掐断「body 也能滚 → 手势落在 body 滚动链上 → #stream 拿不到手势」的双滚动链问题。
3. **dvh 探测兜底**：启动脚本探 `100dvh` 元素实高是否与 `window.innerHeight` 一致，不一致
   （老 WebView 内核 dvh 被静默忽略）时给 body 加 `position:fixed; inset:0` 类，从包含块
   层面强制钉住视口。

三项叠加后：视口基准正确（dvh）→ 不正确时兜底（fixed）→ 单滚动链（overflow:hidden），
覆盖壳与浏览器两种宿主；浏览器端无回归（现代浏览器 dvh 生效且 body 本就无溢出）。

## 三、壳侧最小 patch（交回主会话执行，本仓库不动 app 仓库）

### Patch 1（推荐，一并做）：软键盘适配

`mobile-remote-app/app/src/main/AndroidManifest.xml` 第 19-20 行的 activity 声明：

```xml
<activity
    android:name=".MainActivity"
    android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|smallestScreenSize"
    android:exported="true"
    android:screenOrientation="portrait"
    android:windowSoftInputMode="adjustResize">   ← 新增此行
```

沉浸式全屏（SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN）+ adjustResize 在 API 30+ 会被
`setDecorFitsSystemWindows(false)` 语义影响；当前主题未关 decorFitsSystemWindows，
`adjustResize` 生效无障碍。若实测仍不缩：在 MainActivity.applyImmersiveMode() 里补

```kotlin
window.setDecorFitsSystemWindows(true)   // 或 targetApi<30 无需处理
```

### Patch 2（可选，诊断辅助）：保留 USB 调试通道

`MainActivity.kt` setupWebView()（约 :74-88）可加（仅 debug 构建需要）：

```kotlin
WebView.setWebContentsDebuggingEnabled(true)   // import android.webkit.WebView 已有
```

真机定位手段（本任务因无 USB 连接未走）：`chrome://inspect` → 选 `com.dsh.mobileremote`
的 WebView → Elements/Console 直接量：

```js
document.documentElement.scrollHeight      // 修复前 > window.innerHeight 即复现本文推断
document.querySelector('#stream').getBoundingClientRect().height
getComputedStyle(document.body).height
```

## 四、验收路径

1. 重装 APK（页面修复随插件服务端页面即时生效，壳无需重装——壳只加载 URL；若做 Patch 1 则需重装）。
2. APK 内打开长会话：能滑到底、输入框不被导航栏遮住。
3. 浏览器端回归：滚动、思考块、历史区不受影响（本仓库冒烟 70 项全绿已覆盖逻辑面）。
