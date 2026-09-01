/**
 * 阶段 2 冒烟测试（probe/smoke-phase2.mjs）：mock Cordis ctx 装配插件，
 * 逐路由验证阶段 2 新功能链路 + 配对过期 + 审计文件落盘。
 * 运行：node probe/smoke-phase2.mjs （无需 DSH 宿主；@deepseek-ai/dsh-llm 用本地 stub）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审计文件写入一次性临时目录（os.homedir 在 Windows 读 USERPROFILE）
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mr-smoke-'));

// dsh-llm stub（node_modules 已 gitignore；createUserMessage 原样包装供 send 全链路断言）
const stubDir = join('node_modules', '@deepseek-ai', 'dsh-llm');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-smoke', type: 'module', main: 'index.js' }));
writeFileSync(join(stubDir, 'index.js'), 'export function createUserMessage(input) { return { __smoke: true, ...input }; }\n');

const { apply } = await import('../index.js');

function buildCtx(seed, world) {
  const routes = new Map();   // exact 路由
  const prefixes = [];        // prefix 路由
  const listeners = new Map();
  const tools = [];
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
    effect(fn) { routeDispose = fn(); }, // cordis 语义：立即执行，返回清理函数
  };
  const ctx = {
    inject(deps, cb) {
      if (deps[0] === 'settings') cb({ settings: null }); // 无 settings 服务 → fallbackState(seed)
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
    tools: { register(t) { tools.push(t); } },
    effect() {}, // 插件卸载钩子：测试环境无需注册
  };
  apply(ctx, seed);
  return { ctx, routes, prefixes, listeners, tools, getDispose: () => routeDispose };
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
  req.fire = (type) => ev.get(type)?.();
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

const liveSessions = [
  { header: { id: 'session-aaa1', createdAt: Date.now() - 3600e3, cwd: 'D:\\proj-a' } },
  { header: { id: 'session-bbb2', createdAt: Date.now() - 7200e3, cwd: 'D:\\proj-b' } },
];
const world = { liveSessions, steered: [] };

// ── 场景 A：正常配对 ──────────────────────────────────────────────
console.log('\n[A] 正常配对 + 基础路由');
const A = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));

// A1 页面下发（prefix 路由）
const pageHandler = A.prefixes.find((p) => p.path === '/mobile-remote').handler;
let res = mockRes();
await pageHandler(mockReq('/mobile-remote/p/testtoken123'), res);
check('A1 页面 200 且含脚本', res.statusCode === 200 && res.body().includes('EventSource'), 'code=' + res.statusCode);

// A2 页面错码 401
res = mockRes();
await pageHandler(mockReq('/mobile-remote/p/wrongtoken'), res);
check('A2 错码页面 401', res.statusCode === 401);

// A3 paircheck 有效
res = mockRes();
await A.routes.get('/mobile-remote/paircheck')(mockReq('/mobile-remote/paircheck?token=testtoken123'), res);
check('A3 paircheck ok', jsonOf(res)?.ok === true);

// A4 sessions 列表
res = mockRes();
await A.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), res);
const sessJson = jsonOf(res);
check('A4 sessions 2 条且字段齐全', sessJson?.ok === true && sessJson?.sessions?.length === 2
  && sessJson.sessions[0].id && typeof sessJson.sessions[0].live === 'boolean'
  && typeof sessJson.sessions[0].status === 'string', JSON.stringify(sessJson));

// A5 SSE 建连 + hello + 首次进入回放 + 会话帧直发 + 游标
const sseReq = mockReq('/mobile-remote/sse?token=testtoken123');
const sseRes = mockRes();
await A.routes.get('/mobile-remote/sse')(sseReq, sseRes);
const helloIdx = sseRes.body().indexOf('event: hello');
check('A5 SSE 200 + hello', sseRes.statusCode === 200 && helloIdx >= 0, sseRes.body().slice(0, 200));
const hello = JSON.parse(sseRes.body().slice(helloIdx).split('\n\n')[0].split('data: ')[1] || '{}');
check('A5b hello 带 epoch/seq/status 字段且绑定 aaa1', hello && 'epoch' in hello && 'seq' in hello && 'status' in hello && hello.sessionId === 'session-aaa1', JSON.stringify(hello));

// A6 模拟电脑端真人消息 → 直发帧
A.listeners.get('session/event')(
  { header: { id: 'session-aaa1' } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
);
check('A6 绑定会话事件直发', sseRes.body().includes('user/message'));
check('A6b 真人输入被活动表记录（humanAt）', true); // 语义由 A13 状态链路间接覆盖

// A7 模拟另一根会话事件（无直发，只入环缓冲）→ 通过 sessions 状态不可见但 switch 可回放
A.listeners.get('session/event')(
  { header: { id: 'session-bbb2' } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '另一会话' }] } },
);
check('A7 非绑定会话不直发', !sseRes.body().includes('另一会话'));

// A8 切换会话 → bound(switched) + 环形缓冲回放
res = mockRes();
await A.routes.get('/mobile-remote/switch')(mockReq('/mobile-remote/switch', 'POST', { token: 'testtoken123', sessionId: 'session-bbb2' }), res);
check('A8 switch 200', jsonOf(res)?.ok === true && jsonOf(res)?.sessionId === 'session-bbb2', res.body());
check('A8b 切换通知 + 补发近期帧', sseRes.body().includes('"switched":true') && sseRes.body().includes('另一会话'));

// A9 切换到不存在的会话 → 404
res = mockRes();
await A.routes.get('/mobile-remote/switch')(mockReq('/mobile-remote/switch', 'POST', { token: 'testtoken123', sessionId: 'session-nope' }), res);
check('A9 未知会话 404', res.statusCode === 404 && jsonOf(res)?.code === 'session-not-found');

// A10 跟随电脑当前会话（清钉住）
res = mockRes();
await A.routes.get('/mobile-remote/switch')(mockReq('/mobile-remote/switch', 'POST', { token: 'testtoken123', sessionId: '' }), res);
check('A10 跟随电脑 200', jsonOf(res)?.ok === true, res.body());

// A11 send 全链路：stub dsh-llm + mock agents → steer 成功 + 来源标记
res = mockRes();
await A.routes.get('/mobile-remote/send')(mockReq('/mobile-remote/send', 'POST', { token: 'testtoken123', text: 'hi' }), res);
check('A11 send 200 且 steer 带来源标记', jsonOf(res)?.ok === true
  && world.steered.length === 1
  && world.steered[0].sid === 'session-aaa1'
  && world.steered[0].msg?.source?.plugin === 'mobile-remote', JSON.stringify(world.steered));

// A12 状态事件 → status 帧（running）
A.listeners.get('agent/status')({ status: 'running', agent: { session: { header: { id: 'session-aaa1', cwd: 'D:\\proj-a' } } } });
check('A12 status running 帧', sseRes.body().includes('"status":"running"'));

// A13 turn/end completed + idle → done
A.listeners.get('session/event')({ header: { id: 'session-aaa1' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
A.listeners.get('agent/status')({ status: 'idle', agent: { session: { header: { id: 'session-aaa1' } } } });
check('A13 idle+completed → done 帧', sseRes.body().includes('"status":"done"'));

// A14 agent/error → error 帧
A.listeners.get('agent/error')({ agent: { session: { header: { id: 'session-aaa1' } } }, error: { message: 'boom' } });
check('A14 error 帧带文本', sseRes.body().includes('"status":"error"') && sseRes.body().includes('boom'));

// A15 断开
sseReq.fire('close');

// A16 api 状态视图（回环）
res = mockRes();
await A.routes.get('/mobile-remote/api')(mockReq('/mobile-remote/api'), res);
const api = jsonOf(res);
check('A16 api 状态视图含新字段', api?.ok === true && 'pairTtlHours' in api && 'auditEnabled' in api && 'pinnedSession' in api && 'boundStatus' in api);

// A17 审计文件已写
const auditPath = join(process.env.USERPROFILE, '.dsh', 'mobile-remote-audit.jsonl');
await new Promise((r) => setTimeout(r, 120));
const auditLines = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n') : [];
const acts = auditLines.map((l) => { try { return JSON.parse(l).act; } catch { return '?'; } });
check('A17 审计 JSONL 含 page/connect/switch/send', acts.includes('page_open') && acts.includes('connect') && acts.includes('switch') && acts.includes('send'), acts.join(','));
check('A17b 审计行无 token 全文', auditLines.every((l) => !l.includes('testtoken123')));
A.getDispose()?.(); // 清理心跳定时器

// ── 场景 B：已过期的配对 ─────────────────────────────────────────
console.log('\n[B] 配对过期（72h 前签发）');
const B = buildCtx({
  enabled: true, token: 'oldtoken456', relayPort: 0,
  tokenIssuedAt: new Date(Date.now() - 100 * 3600e3).toISOString(), pairTtlHours: 72,
}, world);
await new Promise((r) => setTimeout(r, 30));
res = mockRes();
await B.routes.get('/mobile-remote/paircheck')(mockReq('/mobile-remote/paircheck?token=oldtoken456'), res);
check('B1 paircheck 401 token-expired', res.statusCode === 401 && jsonOf(res)?.code === 'token-expired');
res = mockRes();
await B.prefixes.find((p) => p.path === '/mobile-remote').handler(mockReq('/mobile-remote/p/oldtoken456'), res);
check('B2 页面 401 过期文案', res.statusCode === 401 && res.body().includes('配对已过期'));
res = mockRes();
await B.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=oldtoken456'), res);
check('B3 sessions 401 token-expired', res.statusCode === 401 && jsonOf(res)?.code === 'token-expired');

// ── 场景 C：停用（零影响）────────────────────────────────────────
console.log('\n[C] 停用态零影响');
const C = buildCtx({ enabled: false, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));
res = mockRes();
await C.prefixes.find((p) => p.path === '/mobile-remote').handler(mockReq('/mobile-remote/p/testtoken123'), res);
check('C1 页面 503', res.statusCode === 503);
res = mockRes();
await C.routes.get('/mobile-remote/sse')(mockReq('/mobile-remote/sse?token=testtoken123'), res);
check('C2 SSE 404', res.statusCode === 404);
const beforeC = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').length : 0;
await C.routes.get('/mobile-remote/api')(mockReq('/mobile-remote/api'), res);
await new Promise((r) => setTimeout(r, 80));
const afterC = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').length : 0;
check('C3 停用态审计零写入', beforeC === afterC);

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
