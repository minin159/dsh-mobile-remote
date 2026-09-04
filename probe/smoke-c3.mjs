/**
 * C3 冒烟测试（probe/smoke-c3.mjs）：mock Cordis ctx 装配插件，验证
 *   A 组 · feat(new-session) 空会话不存档：/new 记账 → /drop 双端校验 → sessionController.drop；
 *   B 组 · feat(delete) 删除确认：守卫矩阵（live 禁删 / 非 persisted 禁删 / 绑定禁删 / 404）
 *         + 删除成功路径 + 审计 session_delete；
 *   C 组 · live 会话禁删（页面端置灰 + 服务端 409 兜底）。
 * 运行：node probe/smoke-c3.mjs（无需 DSH 宿主、无需浏览器）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审计文件写入一次性临时目录（os.homedir 在 Windows 读 USERPROFILE）
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mr-smoke-c3-'));

// dsh-llm stub（与 smoke-phase2 同构）
const stubDir = join('node_modules', '@deepseek-ai', 'dsh-llm');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-smoke', type: 'module', main: 'index.js' }));
writeFileSync(join(stubDir, 'index.js'), 'export function createUserMessage(input) { return { __smoke: true, ...input }; }\n');

const { apply } = await import('../index.js');

// ── mock 世界 ─────────────────────────────────────────────────────────────
// 会话目录：listSessions 全量视图（live/persisted 标志是 /delete 守卫的判据）
//   live-1   live=true          —— 运行中 → 禁删（C 组）
//   hist-1   live=false persisted=true —— 正常历史会话 → 可删（B 组主路径）
//   ghost-1  live=false persisted=false —— 非 persisted → 禁删
//   bound-1  live=false persisted=true —— 删除时设为当前绑定 → 禁删
const allSessions = () => [
  { header: { id: 'session-live-1', createdAt: '2026-09-05T08:00:00Z', cwd: 'D:/work/live' }, live: true, persisted: true },
  { header: { id: 'session-hist-1', createdAt: '2026-09-04T08:00:00Z', cwd: 'D:/work/old' }, live: false, persisted: true },
  { header: { id: 'session-ghost-1', createdAt: '2026-09-04T07:00:00Z', cwd: 'D:/work/ghost' }, live: false, persisted: false },
  { header: { id: 'session-bound-1', createdAt: '2026-09-03T08:00:00Z', cwd: 'D:/work/bound' }, live: false, persisted: true },
];
const world = {
  liveSessions: [], // sessions.list() 空 → pickSession 不可用，绑定只能靠显式路径
  steered: [],
  dropped: [],     // sessionController.drop 调用记录（A/B 组断言核心）
  createCalls: [],
  sessionQuery: { listSessions: async () => allSessions() },
  sessionController: {
    create: async (req) => { world.createCalls.push(req); return { sessionId: 'session-created-' + (world.createCalls.length) }; },
    drop: async (sid) => { world.dropped.push(sid); },
  },
};

function buildCtx(seed, w) {
  const routes = new Map();
  const prefixes = [];
  const listeners = new Map();
  let routeDispose = null;
  const webCtx = {
    webServer: {
      register(route) {
        if (route.kind === 'exact') routes.set(route.path, route.handler);
        else prefixes.push(route);
        return () => {};
      },
      port: 3080,
    },
    effect(fn) { routeDispose = fn(); },
  };
  const ctx = {
    inject(deps, cb) {
      if (deps[0] === 'settings') cb({ settings: null });
      if (deps[0] === 'webServer') cb(webCtx);
    },
    on(event, cb) { listeners.set(event, cb); },
    get(name) {
      if (name === 'sessions') return { list: () => w.liveSessions };
      if (name === 'sessionQuery') return w.sessionQuery || null;
      if (name === 'sessionController') return w.sessionController || null;
      if (name === 'agents') {
        return {
          roots: () => w.liveSessions.map((s) => ({ session: { header: { id: s.header.id, createdAt: s.header.createdAt, cwd: s.header.cwd } } })),
          get: (sid) => ({ steer: (msg) => w.steered.push({ sid, msg }) }),
        };
      }
      return null;
    },
    tools: { register() {} },
    effect() {},
  };
  apply(ctx, seed);
  return { ctx, routes, prefixes, listeners, getDispose: () => routeDispose };
}

function mockReq(url, method = 'GET', body = null) {
  const ev = new Map();
  const req = {
    url, method,
    headers: { host: '127.0.0.1:3080' },
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
  const res = {
    statusCode: 0, headers: {}, chunks: [], finished: false,
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    end(data) { if (data !== undefined) this.chunks.push(String(data)); this.finished = true; },
    write(data) { this.chunks.push(String(data)); return true; },
    destroy() {},
  };
  res.body = () => res.chunks.join('');
  return res;
}

function jsonOf(res) { try { return JSON.parse(res.body()); } catch { return null; } }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail ? '—— ' + detail : ''); }
}

console.log('\n[C3] 空会话不存档 + 移动端删除会话');
const A = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));

// ── A 组：空会话不存档（feat(new-session)）──────────────────────────────
// A1 页面含 newCreatedSid 观察与 /drop 调用（页面端第一道）
let res = mockRes();
await A.prefixes.find((p) => p.path === '/mobile-remote').handler(mockReq('/mobile-remote/p/testtoken123'), res);
const page = res.body();
check('A1a 页面含 newCreatedSid 状态位 + /drop 调用路径', page.includes('newCreatedSid')
  && page.includes("'/mobile-remote/drop'") && page.includes('dropNewSessionIfEmpty'));
check('A1b 页面触发点齐备（pagehide/切换/返回首页）',
  page.includes("addEventListener('pagehide'") && page.includes('dropNewSessionIfEmpty(); // C3：切走前')
  && page.includes("dropNewSessionIfEmpty(); showView('home')"));

// A2 /new 创建 → 服务端记账（后续 /drop 校验的第一道依据）
res = mockRes();
await A.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), res);
const jn = jsonOf(res);
check('A2 /new 成功且新会话已绑定钉住', res.statusCode === 200 && jn.ok === true && jn.sessionId === 'session-created-1',
  res.statusCode + ' ' + res.body());

// A3 零输入空会话 → /drop 放行并调 sessionController.drop
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'testtoken123', sessionId: 'session-created-1' }), res);
check('A3 空会话 drop 成功（drop 被调用 + 响应 ok）',
  res.statusCode === 200 && jsonOf(res).dropped === true
  && world.dropped.includes('session-created-1'),
  res.statusCode + ' ' + res.body() + ' dropped=' + JSON.stringify(world.dropped));

// A4 非本插件所建的会话 → 409 拒绝（电脑端建的会话绝不动）
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'testtoken123', sessionId: 'session-hist-1' }), res);
check('A4 非插件所建会话 drop 被拒（409 not-plugin-created）',
  res.statusCode === 409 && jsonOf(res)?.code === 'not-plugin-created'
  && !world.dropped.includes('session-hist-1'),
  res.statusCode + ' ' + res.body());

// A5 发过消息的插件会话 → 409 拒绝（零输入校验）
//   再建一个会话并注入 user/message 事件进缓冲，然后尝试 drop
res = mockRes();
await A.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), res);
const sid2 = jsonOf(res).sessionId; // session-created-2（已绑定钉住）
A.listeners.get('session/event')({ header: { id: sid2 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '有输入了' }] } });
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'testtoken123', sessionId: sid2 }), res);
check('A5 有消息的插件会话 drop 被拒（409 session-active）',
  res.statusCode === 409 && jsonOf(res)?.code === 'session-active'
  && !world.dropped.includes(sid2),
  res.statusCode + ' ' + res.body());

// A6 drop 失败静默：drop 抛错 → 响应仍 ok（残留无害），审计记失败原因
const dropErr = new Error('boom');
const savedDrop = world.sessionController.drop;
world.sessionController.drop = async (sid) => { throw dropErr; };
res = mockRes();
await A.routes.get('/mobile-remote/new')(mockReq('/mobile-remote/new', 'POST', { token: 'testtoken123' }), res);
const sid3 = jsonOf(res).sessionId;
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'testtoken123', sessionId: sid3 }), res);
check('A6 drop 失败静默（ok + dropped=false，不 5xx）',
  res.statusCode === 200 && jsonOf(res)?.ok === true && jsonOf(res)?.dropped === false,
  res.statusCode + ' ' + res.body());
world.sessionController.drop = savedDrop;

// A7 错 token 401 / 缺 sid 400
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'nope', sessionId: 'x' }), res);
check('A7a /drop 错码 401', res.statusCode === 401);
res = mockRes();
await A.routes.get('/mobile-remote/drop')(mockReq('/mobile-remote/drop', 'POST', { token: 'testtoken123' }), res);
check('A7b /drop 缺 sid 400', res.statusCode === 400 && jsonOf(res)?.code === 'bad-session');

// ── B 组：删除功能已按用户指示移除（宿主侧无公开删除 API）────────────────
check('B1 /delete 路由已移除（未注册）',
  !A.routes.get('/mobile-remote/delete'), 'route still registered');
check('B2 页面已无删除 UI（delSheet/delConfirm/askDeleteSession 均不存在）',
  !page.includes('id="delSheet"') && !page.includes('id="delConfirm"')
  && !page.includes("'/mobile-remote/delete'") && !page.includes('askDeleteSession'),
  'delete UI remnants in page');

// ── C 组：页面端 vm + mini DOM 基建（删除交互断言已随功能移除，空会话 drop 保留）——
// 页面置灰逻辑在 vm 冒烟里覆盖（canDeleteSession/askDeleteSession 纯函数），
// 服务端兜底已在 B3 断言。这里补页面侧：渲染 live 会话行 → 长按 → 弹窗删除键置灰。
console.log('\n[C3-C] 页面端删除交互（vm + mini DOM）');
// mini DOM 同 smoke-phase4 的形态，仅本组所需最小集合
const innerHTMLWrites = [];
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], _text: '', className: '',
    listeners: {}, style: {}, attrs: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.unshift(c); else this.children.splice(i, 0, c);
      return c;
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
      if (this.id && liveByIdC[this.id] === this) delete liveByIdC[this.id];
    },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return makeEl('span'); },
    get childElementCount() { return this.children.length; },
    get firstElementChild() { return this.children[0] || null; },
    set textContent(v) { this._text = String(v); this.children = []; },
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
  let _id = '';
  Object.defineProperty(el, 'id', {
    get() { return _id; },
    set(v) {
      if (_id && liveByIdC[_id] === el) delete liveByIdC[_id];
      _id = String(v);
      if (_id) liveByIdC[_id] = el;
    },
    configurable: true,
  });
  return el;
}
const byIdC = {};
const liveByIdC = {};
const PRE_IDS_C = new Set([
  'stream', 'toast', 'homeView', 'homeList', 'sumCount', 'segWs', 'segTime',
  'delMask', 'delSheet', 'delTitle', 'delSub', 'delConfirm', 'delCancel',
  'newMsg', 'actionPill', 'refreshBtn', 'introCard', 'introClose', 'followRow',
  'apAllow', 'apReject', 'apTool', 'apReason', 'apQueue', 'apTimer', 'approvalBar',
  'input', 'sendBtn', 'shieldBtn', 'ctxBtn', 'modelBtn', 'shieldSheet', 'shieldCancel',
  'optAsk', 'optAllowAll', 'optDenyAll', 'modelSheet', 'modelMask', 'modelList',
  'modelCur', 'newBtn', 'stoppedBanner', 'resumeBtn', 'replacedBanner', 'takeoverBtn',
  'pairBanner', 'pairBannerText', 'pairRetryBtn', 'connText', 'sumConn', 'backBtn',
  'chatTitle', 'chatView', 'topbar', 'homeTop', 'hintBar', 'shieldBanner',
]);
const docC = {
  visibilityState: 'visible',
  body: makeEl('body'),
  getElementById(id) {
    if (liveByIdC[id]) return liveByIdC[id];
    if (byIdC[id]) return byIdC[id];
    if (PRE_IDS_C.has(id)) { byIdC[id] = makeEl('div'); return byIdC[id]; }
    return null;
  },
  createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ nodeType: 3, text: String(t) }),
  querySelectorAll: () => [],
  addEventListener() {},
};
const storageC = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};
const fetchCalls = [];
// fetch mock：/delete 与 /drop 返回已决议响应（让 then 链执行到断言点），
// 其余路径挂起（启动请求不返回，同 smoke-phase4 的设计）。
const RESP_OK_DELETE = { ok: true, json: async () => ({ ok: true, deleted: true }) };
const RESP_OK_DROP = { ok: true, json: async () => ({ ok: true, dropped: true }) };
const RESP_REJECT = { ok: false, json: async () => ({ ok: false, code: 'session-live', message: '运行中的会话不能删除' }) };
const sandboxC = {
  document: docC,
  window: { addEventListener() {} },
  location: { pathname: '/mobile-remote/p/testtoken123' },
  navigator: {}, // 无 sendBeacon → postJSON 回退路径（fetch 挂起）
  sessionStorage: storageC(), localStorage: storageC(),
  fetch: (path, opts) => {
    fetchCalls.push({ path, opts });
    const p = String(path);
    if (p.includes('/mobile-remote/delete')) {
      // 默认成功；测试可用 sandboxC.__nextDeleteResp 切换（如失败响应）
      const resp = sandboxC.__nextDeleteResp || RESP_OK_DELETE;
      sandboxC.__nextDeleteResp = null;
      return Promise.resolve(resp);
    }
    if (p.includes('/mobile-remote/drop')) {
      return Promise.resolve(sandboxC.__nextDropResp || RESP_OK_DROP);
    }
    return new Promise(() => {});
  },
  EventSource: class { constructor() { this.readyState = 0; } addEventListener() {} close() {} },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame(f) { f(); },
  console,
};
sandboxC.__nextDeleteResp = null;
sandboxC.__nextDropResp = null;
// 页面事件监听走 window.addEventListener（pagehide 等）——mini window 收集后按名触发
const windowListeners = {};
sandboxC.window.addEventListener = (t, f) => { (windowListeners[t] = windowListeners[t] || []).push(f); };
{
  const { readFileSync: rf } = await import('node:fs');
  const html = rf(new URL('../web/page.html', import.meta.url), 'utf8');
  const vm = (await import('node:vm')).default;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.createContext(sandboxC);
  vm.runInContext(script, sandboxC, { filename: 'page.html' });
}
// C5 空会话不存档（页面端）：newCreatedSid 有值 + 零消息 → pagehide 发 /drop
{
  fetchCalls.length = 0;
  sandboxC.state.newCreatedSid = 'session-created-9';
  sandboxC.state.sessionId = 'session-created-9';
  sandboxC.clearStream(); // 消息流为空（零输入）
  (windowListeners.pagehide || []).forEach((fn) => fn());
  const call = fetchCalls.find((c) => String(c.path).includes('/mobile-remote/drop'));
  check('C5 pagehide 触发空会话 drop（POST /drop）',
    !!call && JSON.parse(call.opts.body).sessionId === 'session-created-9',
    JSON.stringify(fetchCalls.map((c) => c.path)));
  check('C5b drop 后解除观察（newCreatedSid 清空）', sandboxC.state.newCreatedSid === null);
}
// C6 有消息的新建会话 → 不触发 drop
{
  fetchCalls.length = 0;
  sandboxC.state.newCreatedSid = 'session-created-10';
  sandboxC.state.sessionId = 'session-created-10';
  sandboxC.clearStream();
  sandboxC.addBubble('me', '已经有对话了', '📱 · 12:00', false); // 流里有用户消息
  (windowListeners.pagehide || []).forEach((fn) => fn());
  check('C6 有对话内容的新建会话不 drop',
    sandboxC.state.newCreatedSid === null
    && !fetchCalls.some((c) => String(c.path).includes('/mobile-remote/drop')),
    JSON.stringify(fetchCalls.map((c) => c.path)));
}

A.getDispose?.();
console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
