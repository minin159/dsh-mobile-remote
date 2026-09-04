/**
 * 阶段 4 冒烟测试（probe/smoke-phase4.mjs）：
 *  D 组：web/page.html 脚本在 vm + mini DOM stub 中跑真函数——表格/行内代码渲染、
 *        防注入（全程不经 innerHTML）、cwd 分组与相对时间等纯逻辑；
 *  E 组：mock ctx 装配插件，断言 /mobile-remote/sessions 新增 lastAt（阶段 4 后端唯一改动）。
 * 运行：node probe/smoke-phase4.mjs （无需 DSH 宿主、无需浏览器）。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' —— ' + extra : '')); }
}

// ── mini DOM stub：够页面脚本启动 + 渲染函数断言用 ─────────────────────────
const innerHTMLWrites = []; // 记录所有 innerHTML 写入（防注入断言：渲染路径不允许）
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    _text: '',
    className: '',
    listeners: {},
    style: {},
    attrs: {},
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.unshift(c);
      else this.children.splice(i, 0, c);
      return c;
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
      if (this.id && liveById[this.id] === this) delete liveById[this.id];
    },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return makeEl('span'); },
    classList: {
      add() {}, remove() {}, contains() { return false; },
      toggle() { return false; },
    },
    get childElementCount() { return this.children.length; },
    get firstElementChild() { return this.children[0] || null; },
    set textContent(v) { this._text = String(v); this.children = []; },
    // 真实 DOM 语义：textContent 递归聚合子节点（含文本节点）
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join('');
    },
    set innerHTML(v) { this._innerHTML = v; innerHTMLWrites.push(String(v)); this.children = []; },
    get innerHTML() { return this._innerHTML || ''; },
  };
  el._classes = new Set();
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    },
  };
  // id 赋值即注册（真实 DOM 语义）：getElementById 可查到；remove 时注销
  let _id = '';
  Object.defineProperty(el, 'id', {
    get() { return _id; },
    set(v) {
      if (_id && liveById[_id] === el) delete liveById[_id];
      _id = String(v);
      if (_id) liveById[_id] = el;
    },
    configurable: true,
  });
  return el;
}
function walk(el, fn) {
  fn(el);
  for (const c of (el.children || [])) {
    if (c && c.children) walk(c, fn);
  }
}
function findAll(el, pred) {
  const out = [];
  walk(el, (n) => { if (pred(n)) out.push(n); });
  return out;
}
const byId = {};      // 静态页面元素（启动自动预建）+ 动态 id 注册（makeEl id setter）
const liveById = {}; // 仅真实注册过的动态 id（el.id = 'x' 赋值即入册；remove 注销）
const doc = {
  visibilityState: 'visible',
  body: makeEl('body'),
  // 真实 DOM 语义：只在元素持有该 id 时返回；未注册返回 null。
  // 页面启动路径访问的静态元素由脚本运行前的 preIds 兜底预建。
  getElementById(id) {
    if (liveById[id]) return liveById[id];
    if (byId[id]) return byId[id];
    if (PRE_IDS.has(id)) { byId[id] = makeEl('div'); return byId[id]; }
    return null;
  },
  createElement(tag) { return makeEl(tag); },
  createTextNode(t) { return { nodeType: 3, text: String(t) }; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
// 页面启动即访问的静态元素清单（与 web/page.html 的 <div id=…> 对齐）
const PRE_IDS = new Set([
  'stream', 'toast', 'connDot', 'connText', 'homeView', 'homeTop', 'sumRow', 'sumConn',
  'sumCount', 'refreshBtn', 'introCard', 'introClose', 'followRow', 'homeList', 'actionPill',
  'newMsg', 'chatView', 'topbar', 'backBtn', 'chatTitle', 'statusChip', 'approvalBar', 'apText',
  'apAllow', 'apReject', 'composer', 'input', 'sendBtn', 'shieldBtn', 'ctxBtn', 'ctxInfo',
  'modelBtn', 'shieldSheet', 'shieldCancel', 'optAsk', 'optAllowAll', 'optDenyAll',
  'modelSheet', 'modelCancel', 'modelList', 'segWs', 'segTime', 'newBtn', 'stoppedBanner',
  'resumeBtn', 'replacedBanner', 'takeoverBtn', 'pairRetryBtn', 'connLostBanner',
]);
const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

const sandbox = {
  document: doc,
  window: { addEventListener() {} },
  location: { pathname: '/mobile-remote/p/testtoken123' },
  sessionStorage: storage(),
  localStorage: storage(),
  fetch: () => new Promise(() => {}), // 挂起：启动路径的请求不返回
  EventSource: class { constructor() { this.readyState = 0; } addEventListener() {} close() {} },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame(f) { f(); },
  console,
};
vm.createContext(sandbox);
const html = readFileSync(new URL('../web/page.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
vm.runInContext(script, sandbox, { filename: 'page.html' });

console.log('\n[D] 页面前端逻辑（vm + mini DOM）');

// D1 双视图元素与初始视图（body class 由页面脚本 classList.toggle 控制）
check('D1 页面启动进入首页视图（state.view + body class view-home）',
  sandbox.state.view === 'home' && doc.body._classes.has('view-home')
    && !doc.body._classes.has('view-chat'));
const VIEW_IDS = ['homeView', 'chatView', 'topbar', 'backBtn', 'chatTitle', 'sumRow',
  'sumConn', 'sumCount', 'refreshBtn', 'introCard', 'followRow', 'homeList', 'actionPill', 'newMsg', 'stream'];
VIEW_IDS.forEach((id) => doc.getElementById(id)); // 页面按需访问元素；断言前统一预建
check('D1b 双视图关键元素齐备（页面可访问）',
  VIEW_IDS.every((id) => byId[id]),
  '缺元素: ' + VIEW_IDS.filter((id) => !byId[id]).join(','));

// D2 行内代码 chip
{
  const b = makeEl('div');
  sandbox.appendInline(b, '前文 `npm run dev` 后文');
  const chips = b.children.filter((c) => c.className === 'codeChip');
  check('D2 行内代码渲染为 chip', chips.length === 1 && chips[0].textContent === 'npm run dev'
    && b.children.length === 3, JSON.stringify(b.children.map((c) => c.textContent)));
}
// D3 行内代码防注入：反引号内 HTML 只进 textContent
{
  const b = makeEl('div');
  sandbox.appendInline(b, '`<img src=x onerror=alert(1)>`');
  const chips = b.children.filter((c) => c.className === 'codeChip');
  check('D3 行内代码 HTML 不执行（textContent）', chips.length === 1
    && chips[0].textContent === '<img src=x onerror=alert(1)>'
    && chips[0].children.length === 0);
}
// D4 孤反引号不成 chip
{
  const b = makeEl('div');
  sandbox.appendInline(b, "don't ` lonely");
  check('D4 孤反引号保持纯文本', b.children.every((c) => c.className !== 'codeChip'));
}
// D5 表格受控构建
{
  const b = makeEl('div');
  sandbox.renderContent(b, '说明：\n\n| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n结尾');
  const wraps = findAll(b, (n) => n.className === 'tblWrap');
  check('D5 markdown 表格构建', wraps.length === 1, 'wraps=' + wraps.length);
  const table = wraps[0] && wraps[0].children[0];
  const ths = findAll(table, (n) => n.tagName === 'TH');
  const tds = findAll(table, (n) => n.tagName === 'TD');
  check('D5b 表头/数据行单元格数', ths.length === 2 && tds.length === 4,
    'th=' + ths.length + ' td=' + tds.length);
  check('D5c 表格前后普通文本保留', /说明：/.test(b.textContent) && /结尾/.test(b.textContent));
}
// D6 表格单元格 HTML 注入不执行 + 渲染路径零 innerHTML
{
  const before = innerHTMLWrites.length;
  const b = makeEl('div');
  sandbox.renderContent(b, '| a | b |\n| --- | --- |\n| <script>alert(1)</script> | <img src=x> |');
  const tds = findAll(b, (n) => n.tagName === 'TD');
  check('D6 表格单元格 HTML 仅文本', tds.length === 2
    && tds[0].textContent === '<script>alert(1)</script>'
    && tds[0].children.every((c) => c.nodeType === 3) // 只有文本节点，无元素被解析执行
    && tds[1].textContent === '<img src=x>');
  check('D6b 渲染路径零 innerHTML 写入', innerHTMLWrites.length === before);
}
// D7 列数不一致的行不被吞进表格；--- 水平线不当分隔行
{
  const b = makeEl('div');
  sandbox.renderContent(b, '| a | b |\n| --- | --- |\n| 只有一列 |\n\n---\n\n文本');
  const wraps = findAll(b, (n) => n.className === 'tblWrap');
  check('D7 列数不符断开表格', wraps.length === 1 && findAll(b, (n) => n.tagName === 'TD').length === 0);
  const b2 = makeEl('div');
  sandbox.renderContent(b2, '---\n\n文本');
  check('D7b 单独 --- 水平线不建表', findAll(b2, (n) => n.className === 'tblWrap').length === 0);
}
// D8 围栏代码块内的表格文本不建表（阶段 2 语义保持）
{
  const b = makeEl('div');
  sandbox.renderContent(b, '前\n```md\n| a | b |\n| --- | --- |\n```\n后');
  check('D8 围栏内竖线不建表', findAll(b, (n) => n.className === 'tblWrap').length === 0
    && findAll(b, (n) => n.className === 'code').length === 1);
}
// D9 cwd 分组：未分组排最后、组内按最近活动倒序
{
  const groups = sandbox.groupSessions([
    { id: 's1', cwd: 'D:/work/alpha', lastAt: 100, createdAt: 1 },
    { id: 's2', cwd: 'D:/work/beta', lastAt: 900, createdAt: 2 },
    { id: 's3', cwd: '', lastAt: 500, createdAt: 3 },
    { id: 's4', cwd: 'D:/work/alpha', lastAt: 800, createdAt: 4 },
    { id: 's5', cwd: 'D:/work/alpha', lastAt: 200, createdAt: 5 },
  ]);
  check('D9 分组数与顺序（最近活动优先，未分组最后）',
    groups.length === 3 && groups[0].name === 'beta' && groups[1].name === 'alpha'
    && groups[2].name === '未分组',
    JSON.stringify(groups.map((g) => g.name)));
  check('D9b 组内按最近活动倒序',
    groups[1].items.map((i) => i.id).join(',') === 's4,s5,s1');
  check('D9c 组级最近活动取最大值', groups[1].lastAt === 800);
}
// D10 cwd 末段 / 标题回退链
{
  check('D10 cwdBasename（Windows 反斜杠）', sandbox.cwdBasename('D:\\a\\b\\proj') === 'proj');
  check('D10b 空 cwd = 未分组', sandbox.cwdBasename('') === '未分组');
  check('D10c 标题回退：标题 > 工作区名·短id > 会话·短id',
    sandbox.sessionTitle({ title: 'T' }) === 'T'
    && sandbox.sessionTitle({ id: 'session-1234567890', cwd: 'D:/x/demo' }) === 'demo · 12345678'
    && sandbox.sessionTitle({ id: 'session-1234567890', cwd: '' }) === '会话 12345678');
}
// D11 相对时间档位
{
  const now = Date.now();
  check('D11 fmtRel 档位', sandbox.fmtRel(now - 30 * 1000) === '刚刚'
    && sandbox.fmtRel(now - 5 * 60 * 1000) === '5 分钟前'
    && sandbox.fmtRel(now - 3 * 3600 * 1000) === '3 小时前'
    && sandbox.fmtRel(now - 2 * 86400 * 1000) === '2 天前'
    && /月\d+日/.test(sandbox.fmtRel(now - 30 * 86400 * 1000)));
  check('D11b 无时间戳返回空串', sandbox.fmtRel(0) === '' && sandbox.fmtRel(undefined) === '');
}
// D12 工具参数摘要：压平空白 + 截断
{
  check('D12 argsSummary 截断', sandbox.argsSummary({ command: 'npm ' + 'x'.repeat(80) }).length <= 41
    && sandbox.argsSummary({ a: 1 }).includes('"a":1'));
}
// D13 renderHome 全链路（构建卡片/任务行/汇总行，防函数缺失回归）
{
  const byId4 = { s1: { id: 's1', cwd: 'D:/w/alpha', status: 'running', bound: true, lastAt: Date.now(), createdAt: 1 },
    s2: { id: 's2', cwd: 'D:/w/alpha', status: 'ended', live: false, persisted: true, createdAt: 2 },
    s3: { id: 's3', cwd: '', status: 'idle', createdAt: 3 } };
  sandbox.state.sessionsById = byId4;
  sandbox.state.homeDirty = true;
  let threw = '';
  try { sandbox.renderHome(); } catch (e) { threw = String(e); }
  const homeList = byId.homeList;
  const cards = homeList.children.filter((c) => c.className === 'wsCard');
  const sumText = byId.sumCount.textContent;
  check('D13 renderHome 构建工作区卡片 + 汇总行', threw === '' && cards.length === 2
    && sumText === '2 个工作区 · 3 个任务',
    (threw || 'cards=' + cards.length + ' sum=' + sumText));
  const chip1 = sandbox.state.rowChips.s1;
  check('D13b 任务行四态胶囊与绑定行', chip1 && chip1.textContent === '运行中' && chip1.className.includes('run')
    && sandbox.state.rowRows.s1.className.includes('bound'));
}
// D14 时间线分组（优3）：倒序 + 自然日分组 + 组内保持倒序
{
  // 用「今天中午」为锚点构造时间戳，避免测试在凌晨运行时「昨天」漂移
  const nowBase = new Date();
  const noon = new Date(nowBase.getFullYear(), nowBase.getMonth(), nowBase.getDate(), 12).getTime();
  const day = 86400 * 1000;
  const groups = sandbox.timeSessions([
    { id: 't1', lastAt: noon - 2 * 3600 * 1000, createdAt: 1 },   // 今天
    { id: 't2', lastAt: noon - 1 * day, createdAt: 2 },           // 昨天
    { id: 't3', lastAt: noon - 1 * 3600 * 1000, createdAt: 3 },   // 今天（排 t1 前）
    { id: 't4', lastAt: noon - 9 * day, createdAt: 4 },           // 更早
    { id: 't5' },                                                 // 无任何时间 → 日期未知
  ]);
  check('D14 时间线分组顺序（倒序、无时间垫底）',
    groups.length === 4 && groups[0].items.map((i) => i.id).join(',') === 't3,t1'
      && groups[3].label === '日期未知',
    JSON.stringify(groups.map((g) => [g.label, g.items.map((i) => i.id)])));
  check('D14b 今天组标签', /^今天 · \d+月\d+日$/.test(groups[0].label), groups[0].label);
  check('D14c 昨天组标签', /^昨天 · \d+月\d+日$/.test(groups[1].label), groups[1].label);
  check('D14d 更早组标签（周X 或完整日期）',
    /^(周[一二三四五六日] · \d+月\d+日|\d{4}年\d+月\d+日)$/.test(groups[2].label), groups[2].label);
}
// D15 fmtDayLabel 档位：近一周用周X，更早用完整年月日
{
  const now = Date.now();
  const day = 86400 * 1000;
  check('D15 近一周用周X', /^(周[一二三四五六日]) · \d+月\d+日$/.test(sandbox.fmtDayLabel(now - 3 * day)),
    sandbox.fmtDayLabel(now - 3 * day));
  check('D15b 更早用完整日期', /^\d{4}年\d+月\d+日$/.test(sandbox.fmtDayLabel(now - 40 * day)),
    sandbox.fmtDayLabel(now - 40 * day));
}
// D16 setHomeMode 切换 + 时间线 renderHome 全链路（分段高亮/汇总行/任务行增量注册）
{
  sandbox.state.sessionsById = {
    s1: { id: 's1', cwd: 'D:/w/alpha', status: 'running', lastAt: Date.now(), createdAt: 1 },
    s2: { id: 's2', cwd: 'D:/w/beta', status: 'idle', lastAt: Date.now() - 30 * 1000, createdAt: 2 },
  };
  sandbox.state.homeDirty = true;
  sandbox.setHomeMode('time');
  let threw = '';
  try { sandbox.renderHome(); } catch (e) { threw = String(e); }
  const homeList = byId.homeList;
  const cards = homeList.children.filter((c) => c.className === 'wsCard');
  const sumText = byId.sumCount.textContent;
  check('D16 时间线 renderHome（日期卡 + 汇总行）', threw === '' && cards.length === 1
    && sumText === '2 个任务 · 1 天内有活动' && byId.segTime.classList.contains('on'),
    (threw || 'cards=' + cards.length + ' sum=' + sumText));
  check('D16b 时间线任务行注册增量更新通道', !!sandbox.state.rowChips.s1 && !!sandbox.state.rowRows.s2);
  sandbox.setHomeMode('ws');
  sandbox.state.homeDirty = true;
  sandbox.renderHome();
  check('D16c 切回工作区视图恢复原汇总行', byId.sumCount.textContent === '2 个工作区 · 2 个任务'
    && byId.segWs.classList.contains('on') && !byId.segTime.classList.contains('on'));
}
// D17 思考过程可折叠块（C1 feat(thinking)）：流式累积 → 定稿收起 + 摘要 → 展开记忆
{
  const stream = byId.stream;
  const n0 = stream.children.length;
  // 流式：两个 reasoning-delta 增量追加到同一块
  sandbox.appendThinking(3, 1, '先分析');
  sandbox.appendThinking(3, 1, '问题\n再列步骤');
  const tb = sandbox.thinkBlocks['3:1'];
  check('D17 流式思考块创建并累积', !!tb && tb.el.className === 'thinkBlock'
    && tb.body.textContent === '先分析问题\n再列步骤'
    && stream.children[stream.children.length - 1] === tb.el
    && stream.children.length === n0 + 1,
    'text=' + JSON.stringify(tb && tb.body.textContent));
  check('D17b 流式摘要行（思考中 + 行数/字数）', tb.sum.textContent === '🤔 思考中… 2 行 · 10 字',
    'sum=' + tb.sum.textContent);
  check('D17c 流式期间默认收起（无展开记忆）', !tb.el._classes.has('open'));
  check('D17d 定稿无 reasoning → 保留流式累积',
    (() => { sandbox.settleThinking(3, 1, ''); return tb.sum.textContent === '🤔 已思考 · 2 行 · 10 字'
      && tb.body.textContent === '先分析问题\n再列步骤' && !tb.el._classes.has('open'); })(),
    'sum=' + tb.sum.textContent);
  // 定稿带 reasoning 字段以其为准（换行符计入字数：定稿思考\n两行 = 7 字）
  sandbox.appendThinking(3, 2, '流式内容');
  sandbox.settleThinking(3, 2, '定稿思考\n两行');
  const tb2 = sandbox.thinkBlocks['3:2'];
  check('D17e 定稿 reasoning 覆盖流式累积', tb2 && tb2.body.textContent === '定稿思考\n两行'
    && tb2.sum.textContent === '🤔 已思考 · 2 行 · 7 字' && !tb2.el._classes.has('open'),
    'text=' + JSON.stringify(tb2 && tb2.body.textContent) + ' sum=' + (tb2 && tb2.sum.textContent));
  // 无流式内容的思考（空 delta）+ 空定稿 → 块不保留
  sandbox.showThinking(); // 建块（空文本）
  sandbox.settleThinking(undefined, undefined, '');
  check('D17f 空定稿且无流式内容 → 块移除', !sandbox.thinkBlocks['?:?']);
  // 无流式直接定稿（历史补发帧）：直接落定稿态
  sandbox.settleThinking(5, 1, '历史思考内容');
  const tb3 = sandbox.thinkBlocks['5:1'];
  check('D17g 无流式定稿直接落块', tb3 && tb3.sum.textContent === '🤔 已思考 · 1 行 · 6 字',
    'sum=' + (tb3 && tb3.sum.textContent));
  // 展开记忆：localStorage 写入 + 新块跟随
  const head2 = sandbox.thinkBlocks['5:1'].head;
  (head2.listeners.click || []).forEach((fn) => fn());
  check('D17h 点击展开写 localStorage', sandbox.localStorage.getItem('mr-think-fold') === 'open'
    && sandbox.thinkBlocks['5:1'].el._classes.has('open'));
  // 流式新块跟随展开偏好；但定稿块被 settleThinking 强制收起，不跟随记忆
  sandbox.appendThinking(6, 1, '下一块');
  check('D17i 流式新块跟随展开偏好', sandbox.thinkBlocks['6:1'].el._classes.has('open'));
  // reasoningTextOf：定稿 content 数组提取 reasoning 块
  check('D17j reasoningTextOf 提取', sandbox.reasoningTextOf([
    { type: 'text', text: '回答' }, { type: 'reasoning', text: '思考R' }]) === '思考R'
    && sandbox.reasoningTextOf([{ type: 'text', text: 'x' }]) === ''
    && sandbox.reasoningTextOf(undefined) === '');
  // clearStream 清思考块索引
  sandbox.clearStream();
  check('D17k clearStream 清思考块索引', Object.keys(sandbox.thinkBlocks).length === 0
    && Object.keys(sandbox.streamingBubbles).length === 0);
}
// D18 历史区渲染（C1 feat(history)）：history 帧 → 顶部「历史」分隔条 + 定稿消息
{
  sandbox.clearStream();
  sandbox.state.sessionId = 'session-h1';
  // 先渲染一条 live 帧（模拟缓冲回放先到），历史后到应前插其上
  sandbox.handleSession({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'live 消息' }] } });
  const before = byId.stream.children.length;
  sandbox.renderHistoryFrame({
    sessionId: 'session-h1',
    count: 2, more: true,
    messages: [
      { type: 'user/message', time: 1700000000000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '历史提问' }] } },
      { type: 'assistant/message', time: 1700000001000, data: { message: { content: [{ type: 'reasoning', text: '历史思考' }, { type: 'text', text: '历史回答' }] } } },
    ],
  });
  const stream = byId.stream;
  const sepIdx = stream.children.findIndex((c) => c.id === 'histSep');
  const liveIdx = stream.children.findIndex((c) => (c.textContent || '').includes('live 消息'));
  check('D18 历史分隔条存在且位于 live 消息之上', sepIdx >= 0 && liveIdx > sepIdx,
    'sep=' + sepIdx + ' live=' + liveIdx
    + ' children=' + JSON.stringify(stream.children.map((c) => c.id || c.className)));
  const sep = sepIdx >= 0 ? stream.children[sepIdx] : null;
  check('D18b 分隔条文案', !!sep && sep.textContent === '—— 历史（更早未显示） ——',
    'text=' + (sep && sep.textContent));
  // 历史消息应在分隔条之前（流的顶部），live 帧之后
  const texts = stream.children.map((c) => (c.className === 'bubble' ? c.textContent : ''));
  check('D18c 历史消息渲染到分隔条之上', /历史提问/.test(stream.children.slice(0, sepIdx).map((c) => c.textContent).join(''))
    && /历史回答/.test(stream.children.slice(0, sepIdx).map((c) => c.textContent).join('')),
    JSON.stringify(stream.children.map((c) => c.textContent).slice(0, 6)));
  check('D18d live 消息在分隔条之下（顺序不被破坏）',
    /live 消息/.test(stream.children.slice(sepIdx).map((c) => c.textContent).join('')));
  // 历史 assistant 带 reasoning → 思考块定稿
  const histThink = Object.keys(sandbox.thinkBlocks).length === 1
    && Object.values(sandbox.thinkBlocks)[0].sum.textContent === '🤔 已思考 · 1 行 · 4 字';
  check('D18e 历史思考块定稿（收起 + 摘要）', histThink,
    'sum=' + (Object.values(sandbox.thinkBlocks)[0] || {}).sum);
  // 重复推送 → 去重（不重复渲染）
  const n1 = stream.children.length;
  sandbox.renderHistoryFrame({ sessionId: 'session-h1', messages: [
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '再来一条' }] } }] });
  check('D18f 重复历史帧去重', stream.children.length === n1);
  // 已切走的会话（sessionId 不匹配）→ 丢弃
  sandbox.renderHistoryFrame({ sessionId: 'session-other', messages: [
    { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '迟到帧' }] } }] });
  check('D18g 迟到历史（已切走）丢弃', stream.children.length === n1);
  // clearStream 清掉历史区（切换会话场景）
  sandbox.clearStream();
  check('D18h clearStream 清历史区', byId.stream.children.length === 0);
}

// ── E 组：后端 /sessions 补 lastAt ─────────────────────────────────────────
console.log('\n[E] 后端 /sessions（mock ctx）');
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mr-smoke4-'));
const stubDir = join('node_modules', '@deepseek-ai', 'dsh-llm');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-smoke', type: 'module', main: 'index.js' }));
writeFileSync(join(stubDir, 'index.js'), 'export function createUserMessage(input) { return { __smoke: true, ...input }; }\n');

const { apply } = await import('../index.js');
function buildCtx(seed, world) {
  const routes = new Map();
  const listeners = new Map();
  const webCtx = {
    webServer: { register(r) { if (r.kind === 'exact') routes.set(r.path, r.handler); return () => {}; }, port: 3080 },
    effect(fn) { fn(); },
  };
  const ctx = {
    inject(deps, cb) {
      if (deps[0] === 'settings') cb({ settings: null });
      if (deps[0] === 'webServer') cb(webCtx);
    },
    on(event, cb) { listeners.set(event, cb); },
    get(name) {
      if (name === 'sessions') return { list: () => world.liveSessions };
      if (name === 'sessionQuery') return world.sessionQuery || null;
      if (name === 'sessionController') return world.sessionController || null;
      if (name === 'agents') {
        return {
          roots: () => world.liveSessions.map((s) => ({ session: { header: { id: s.header.id, createdAt: s.header.createdAt, cwd: s.header.cwd } } })),
          get: (sid) => ({ steer: (msg) => world.steered.push({ sid, msg }) }),
        };
      }
      return null;
    },
    tools: { register() {} },
    effect() {},
  };
  apply(ctx, seed);
  return { ctx, routes, listeners };
}
const world = {
  liveSessions: [],
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'session-e4a', createdAt: '2026-09-01T10:00:00Z', cwd: 'D:/work/proj-a' }, live: true, persisted: false },
      { header: { id: 'session-e4b', createdAt: '2026-09-01T09:00:00Z', cwd: '' }, live: false, persisted: true },
    ],
  },
  steered: [],
};
const E = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, world);
function mockReq(url, method = 'GET', body = null) {
  const ev = new Map();
  const req = {
    url, method,
    headers: { host: '127.0.0.1' },
    on(type, cb) { ev.set(type, cb); return req; },
  };
  queueMicrotask(() => {
    try {
      if (body) ev.get('data')?.(Buffer.from(JSON.stringify(body)));
      ev.get('end')?.();
    } catch (e) { console.error('mockReq emit error:', e); }
  });
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, writeHead(c) { this.statusCode = c; }, setHeader() {}, end(b) { this.body = b || ''; } };
}
// 未触发事件前：lastAt = 0（前端回退 createdAt）
const res0 = mockRes();
await E.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), res0);
const j0 = JSON.parse(res0.body);
check('E1 sessions ok 且含 lastAt 字段', j0.ok === true && j0.sessions.length === 2
  && j0.sessions.every((s) => s.lastAt === 0), JSON.stringify(j0.sessions?.[0]));
check('E1b cwd 透传（含空 cwd 止损样本）', j0.sessions[0].cwd === 'D:/work/proj-a' && j0.sessions[1].cwd === '');
// 触发 session/event 后：lastAt = 最近活动时间
const ev = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } };
E.listeners.get('session/event')({ header: { id: 'session-e4a' } }, ev);
const res1 = mockRes();
await E.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), res1);
const j1 = JSON.parse(res1.body);
const a = j1.sessions.find((s) => s.id === 'session-e4a');
const b2 = j1.sessions.find((s) => s.id === 'session-e4b');
check('E2 事件后 lastAt 更新（仅活跃会话）', a && a.lastAt > 0 && b2 && b2.lastAt === 0,
  JSON.stringify({ a: a?.lastAt, b: b2?.lastAt }));

// E3 优3b：无 sessionController → canNew=false，/new 返回 501（不静默失败）
{
  const resS = mockRes();
  await E.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), resS);
  check('E3 无控制器 canNew=false', JSON.parse(resS.body).canNew === false);
  const resN = mockRes();
  await E.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), resN);
  check('E3b /new 无控制器 → 501 new-unavailable', resN.statusCode === 501 && JSON.parse(resN.body).code === 'new-unavailable',
    resN.statusCode + ' ' + resN.body);
}
// E4 优3b：有控制器 → create 调用 + 自动钉住 + canNew=true
{
  const calls = [];
  world.sessionController = { create: async (req) => { calls.push(req); return { sessionId: 'session-new-1' }; } };
  const resN = mockRes();
  await E.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), resN);
  const jn = JSON.parse(resN.body);
  check('E4 /new 创建并返回会话', resN.statusCode === 200 && jn.ok === true && jn.sessionId === 'session-new-1' && jn.live === true,
    resN.statusCode + ' ' + resN.body);
  check('E4b 无绑定 cwd 时默认 D:\\dsh-sessions', calls.length === 1 && calls[0] !== undefined && calls[0].cwd === 'D:\\dsh-sessions',
    JSON.stringify(calls));
  const resS = mockRes();
  await E.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), resS);
  const js = JSON.parse(resS.body);
  check('E4c canNew=true 且 pinned=新会话', js.canNew === true && js.pinnedSession === 'session-new-1',
    JSON.stringify({ canNew: js.canNew, pinned: js.pinnedSession }));
  // E5 优3b（C2 修正）：新建默认落 D:\dsh-sessions（盘符根会 EPERM——DSH create 要在
  //    cwd 下 mkdir，Windows 拒绝盘符根）；请求体显式带 cwd 时以请求为准（预留官方参数面）
  const resSw = mockRes();
  await E.routes.get('/mobile-remote/switch')(mockReq('/mobile-remote/switch', 'POST', { token: 'testtoken123', sessionId: 'session-e4a' }), resSw);
  const resN2 = mockRes();
  await E.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), resN2);
  check('E5 新建默认落 D:\\dsh-sessions（不沿用绑定会话 cwd）', resN2.statusCode === 200 && JSON.parse(resN2.body).sessionId === 'session-new-1'
    && calls[1] !== undefined && calls[1].cwd === 'D:\\dsh-sessions',
    JSON.stringify(calls[1]) + ' sw=' + resSw.statusCode);
  const resN3 = mockRes();
  await E.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123', cwd: 'D:/work/explicit' }), resN3);
  check('E5b 请求体显式 cwd 以请求为准', resN3.statusCode === 200 && calls[2] !== undefined && calls[2].cwd === 'D:/work/explicit',
    JSON.stringify(calls[2]));
  // E7 C2 fix：create 抛错 → 502 且报错信息带目标目录路径（真机 EPERM 便于定位）
  {
    const callsErr = [];
    world.sessionController = { create: async (req) => { callsErr.push(req); throw new Error('EPERM mkdir \'D:\\dsh-sessions\''); } };
    const resN4 = mockRes();
    await E.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), resN4);
    const je = JSON.parse(resN4.body);
    check('E7 create 失败 502 且报错带目标目录', resN4.statusCode === 502 && je.ok === false && je.code === 'create-failed'
      && je.message.includes('D:\\dsh-sessions') && je.cwd === 'D:\\dsh-sessions',
      resN4.statusCode + ' ' + resN4.body);
    world.sessionController = { create: async (req) => { calls.push(req); return { sessionId: 'session-new-1' }; } };
  }
}

// E6 历史回读（C1 feat(history)）：readSession → history 帧（SSE 建连/切换触发）
{
  // SSE mock res：收集 write 帧（真实 handler 只用 write 持续推送）
  function sseRes() {
    return {
      statusCode: 0, frames: [],
      writeHead(c) { this.statusCode = c; }, setHeader() {},
      write(chunk) { this.frames.push(String(chunk)); return true; },
      end() {},
    };
  }
  const frameText = (res) => res.frames.join('');
  // 会话数据：35 条消息（含 chunk 噪声应被跳过、reasoning 定稿应保留）
  const histEvents = [];
  for (let i = 0; i < 30; i++) {
    histEvents.push({ type: 'user/message', seq: i * 2, time: 1700000000000 + i * 1000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问' + i }] } });
    histEvents.push({ type: 'assistant/message', seq: i * 2 + 1, time: 1700000000100 + i * 1000,
      data: { message: { content: [{ type: 'text', text: '答' + i }] } } });
  }
  histEvents.push({ type: 'assistant/chunk', seq: 99, time: 1, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } } });
  let readCalls = 0;
  world.sessionQuery.readSession = async (sid) => {
    readCalls++;
    if (sid === 'session-e4b') throw new Error('persistence corrupt'); // 读失败静默降级
    return { session: { id: sid, createdAt: '2026-09-01T10:00:00Z', cwd: 'D:/work/proj-a' }, events: histEvents };
  };
  // 先切到 session-e4a 并发一条事件（缓冲 1 帧 < 30 → 触发回读）
  E.listeners.get('session/event')({ header: { id: 'session-e4a' } }, {
    type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'live' }] } });
  // SSE 建连（?since 缺省 → 回放缓冲 + history）
  const resSse = sseRes();
  const reqSse = mockReq('/mobile-remote/sse?token=testtoken123', 'GET', null);
  await E.routes.get('/mobile-remote/sse')(reqSse, resSse);
  await new Promise((r) => setTimeout(r, 20)); // 等 maybeSendHistory 异步完成
  const histFrame = resSse.frames.filter((f) => f.startsWith('event: history'))[0];
  check('E6 SSE 建连发 history 帧', !!histFrame, 'frames=' + JSON.stringify(resSse.frames.map((f) => f.split('\n')[0])));
  if (histFrame) {
    const payload = JSON.parse(histFrame.split('\ndata: ')[1]);
    check('E6b history 只含定稿消息（chunk 过滤）且封顶 30 条',
      payload.messages.every((m) => m.type === 'user/message' || m.type === 'assistant/message')
      && payload.messages.length === 30,
      'len=' + payload.messages.length + ' types=' + JSON.stringify([...new Set(payload.messages.map((m) => m.type))]));
    check('E6c history 是最近 30 条（尾部对齐）',
      payload.messages[payload.messages.length - 1].data.message.content[0].text === '答29',
      'last=' + JSON.stringify(payload.messages[payload.messages.length - 1]));
    check('E6d sessionId 标注（与绑定一致）', typeof payload.sessionId === 'string' && payload.sessionId.length > 0,
      'sid=' + payload.sessionId);
  }
  check('E6e readSession 被调用（缓冲 < 30 触发）', readCalls >= 1, 'calls=' + readCalls);
  // 读失败静默降级：切到 session-e4b（readSession 抛错），SSE 仍正常建连、无 history 帧、不抛
  const resSw2 = mockRes();
  await E.routes.get('/mobile-remote/switch')(mockReq('/mobile-remote/switch', 'POST', { token: 'testtoken123', sessionId: 'session-e4b' }), resSw2);
  check('E6f 切换到读失败会话不阻塞（降级为现状）', resSw2.statusCode === 200,
    'sw=' + resSw2.statusCode + ' ' + resSw2.body);
  // 无 readSession 服务（宿主缺失）→ 静默降级不抛
  const savedRead = world.sessionQuery.readSession;
  delete world.sessionQuery.readSession;
  const resSse2 = sseRes();
  let threw = '';
  try { await E.routes.get('/mobile-remote/sse')(mockReq('/mobile-remote/sse?token=testtoken123', 'GET', null), resSse2); }
  catch (e) { threw = String(e); }
  await new Promise((r) => setTimeout(r, 10));
  check('E6g 宿主无 readSession 静默降级（SSE 正常、无 history 帧）',
    threw === '' && !resSse2.frames.some((f) => f.startsWith('event: history')),
    threw || 'has history frame');
  world.sessionQuery.readSession = savedRead;
}

console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail > 0 ? 1 : 0);
