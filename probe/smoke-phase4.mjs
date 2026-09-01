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
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {},
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
const byId = {};
const doc = {
  visibilityState: 'visible',
  body: makeEl('body'),
  getElementById(id) {
    if (!byId[id]) byId[id] = makeEl('div');
    return byId[id];
  },
  createElement(tag) { return makeEl(tag); },
  createTextNode(t) { return { nodeType: 3, text: String(t) }; },
  querySelectorAll() { return []; },
  addEventListener() {},
};

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
function mockReq(url) { return { method: 'GET', url, headers: { host: '127.0.0.1' } }; }
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

console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail > 0 ? 1 : 0);
