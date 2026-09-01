/**
 * 阶段 5 冒烟测试（probe/smoke-phase5.mjs）：mock Cordis ctx 装配插件，
 * 验证盾牌三档审批链路 + 审计 + 页面底栏控件形态。运行：node probe/smoke-phase5.mjs。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审计文件写入一次性临时目录（os.homedir 在 Windows 读 USERPROFILE）
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mr-smoke5-'));

// dsh-llm stub（与 smoke-phase2 同构）
const stubDir = join('node_modules', '@deepseek-ai', 'dsh-llm');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-smoke', type: 'module', main: 'index.js' }));
writeFileSync(join(stubDir, 'index.js'), 'export function createUserMessage(input) { return { __smoke: true, ...input }; }\n');

const { apply } = await import('../index.js');

function buildCtx(seed, world) {
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
  res.frames = (name) => res.body().split('\n\n').filter((f) => f.startsWith('event: ' + name));
  return res;
}

function jsonOf(res) { try { return JSON.parse(res.body()); } catch { return null; } }
function frameData(res, name) {
  const f = res.frames(name).pop();
  if (!f) return null;
  try { return JSON.parse(f.split('data: ')[1]); } catch { return null; }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail ? '—— ' + detail : ''); }
}

const liveSessions = [{ header: { id: 'session-aaa1', createdAt: Date.now() - 3600e3, cwd: 'D:\\proj-a' } }];
const world = { liveSessions, steered: [] };

console.log('\n[5] 盾牌三档 + 底栏控件');
const A = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));

// 5.1 页面含新控件形态：盾牌键/上下文键/警示条/弹层；发送键为 ↑；模型与思考键不渲染
let res = mockRes();
await A.prefixes.find((p) => p.path === '/mobile-remote').handler(mockReq('/mobile-remote/p/testtoken123'), res);
const page = res.body();
check('5.1a 页面含盾牌键/弹层/警示条/上下文键', page.includes('id="shieldBtn"') && page.includes('id="shieldSheet"')
  && page.includes('id="shieldBanner"') && page.includes('id="ctxBtn"'));
check('5.1b 发送键为 ↑ 形态', page.includes('id="sendBtn"') && page.includes('aria-label="发送"') && page.includes('>↑<'));
check('5.1c 模型/思考键未渲染（探针降级）', !page.includes('id="modelBtn"') && !page.includes('id="thinkBtn"'));
check('5.1d 放行警示文案常驻条', page.includes('全部放行——工具操作将自动允许'));

// 5.2 SSE 建连：hello 帧带 shield 档位（默认 ask）
const sseReq = mockReq('/mobile-remote/sse?token=testtoken123');
const sseRes = mockRes();
await A.routes.get('/mobile-remote/sse')(sseReq, sseRes);
check('5.2 hello 带 shield=ask', frameData(sseRes, 'hello')?.shield === 'ask');

// 5.3 切到 allow-all：200 + shield 帧 + api 视图同步
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'testtoken123', mode: 'allow-all' }), res);
check('5.3a 切 allow-all 200 + shield 帧', jsonOf(res)?.ok === true && frameData(sseRes, 'shield')?.mode === 'allow-all');
res = mockRes();
await A.routes.get('/mobile-remote/api')(mockReq('/mobile-remote/api'), res);
check('5.3b api 视图 shield=allow-all', jsonOf(res)?.shield === 'allow-all');

// 5.4 allow-all 审批自动放行：插件决策即终局（P3），SSE 收 shield-allow 通知
let outcome = await A.listeners.get('approval/request')(
  { agent: { session: { header: { id: 'session-aaa1' } } }, toolName: 'bash', reason: 'rm -rf' },
  async () => 'gui',
);
check('5.4a allow-all 自动放行 allowed-once', outcome === 'allowed-once', String(outcome));
check('5.4b 手机端收到自动放行提示帧', (() => { const d = frameData(sseRes, 'approval_result'); return d?.via === 'shield-allow' && d?.decision === 'allowed-once'; })());

// 5.5 deny-all 自动拒绝
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'testtoken123', mode: 'deny-all' }), res);
outcome = await A.listeners.get('approval/request')(
  { agent: { session: { header: { id: 'session-aaa1' } } }, toolName: 'write' },
  async () => 'gui',
);
check('5.5 deny-all 自动拒绝 rejected', outcome === 'rejected' && frameData(sseRes, 'approval_result')?.via === 'shield-deny', String(outcome));

// 5.6 切回 ask：审批走正常手机流程（推条 → POST approve → allowed-once）
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'testtoken123', mode: 'ask' }), res);
const askPromise = A.listeners.get('approval/request')(
  { agent: { session: { header: { id: 'session-aaa1' } } }, toolName: 'bash', reason: 'ls' },
  async () => 'gui',
);
await new Promise((r) => setTimeout(r, 10));
const ap = frameData(sseRes, 'approval');
check('5.6a ask 档推送审批条', ap?.id && ap?.toolName === 'bash');
res = mockRes();
await A.routes.get('/mobile-remote/approve')(mockReq('/mobile-remote/approve', 'POST', { token: 'testtoken123', id: ap.id, decision: 'allow' }), res);
check('5.6b 手机应答生效', jsonOf(res)?.ok === true && (await askPromise) === 'allowed-once');

// 5.7 非法档位 400 / 错码 401
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'testtoken123', mode: 'everything' }), res);
check('5.7a 非法档位 400', res.statusCode === 400 && jsonOf(res)?.code === 'bad-mode');
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'nope', mode: 'ask' }), res);
check('5.7b 错码 401', res.statusCode === 401);

// 5.8 手机断开后盾牌不代答（fail-safe：无连接回落电脑端 GUI）
sseReq.fire('close');
await new Promise((r) => setTimeout(r, 10));
res = mockRes();
await A.routes.get('/mobile-remote/shield')(mockReq('/mobile-remote/shield', 'POST', { token: 'testtoken123', mode: 'allow-all' }), res);
outcome = await A.listeners.get('approval/request')(
  { agent: { session: { header: { id: 'session-aaa1' } } }, toolName: 'bash' },
  async () => 'gui',
);
check('5.8 断线后不代答（回落 GUI）', outcome === 'gui', String(outcome));

// 5.9 重连 hello 兜底同步当前档位（会话级状态跨重连保持）
const sseReq2 = mockReq('/mobile-remote/sse?token=testtoken123');
const sseRes2 = mockRes();
await A.routes.get('/mobile-remote/sse')(sseReq2, sseRes2);
check('5.9 重连 hello 带 shield=allow-all', frameData(sseRes2, 'hello')?.shield === 'allow-all');
sseReq2.fire('close');

// 5.10 审计可回溯：shield_mode 切换记录 + shield 代答决策记录
await new Promise((r) => setTimeout(r, 250));
const auditPath = join(process.env.USERPROFILE, '.dsh', 'mobile-remote-audit.jsonl');
const auditLines = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n') : [];
const auditObjs = auditLines.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const modes = auditObjs.filter((o) => o.act === 'shield_mode').map((o) => o.mode);
const modeCount = (m) => modes.filter((x) => x === m).length;
const shieldDecides = auditObjs.filter((o) => o.act === 'approval_decide' && String(o.via || '').startsWith('shield'));
// 与顺序无关断言：audit() 为 fire-and-forget appendFile（阶段 2 既有实现），并发落盘顺序不保证
check('5.10a 审计含 4 次档位切换（allow-all×2/deny-all/ask）', modeCount('allow-all') === 2 && modeCount('deny-all') === 1 && modeCount('ask') === 1, modes.join(','));
check('5.10b 审计含盾牌代答决策（allow+deny 各一）', shieldDecides.length === 2
  && shieldDecides.some((o) => o.via === 'shield-allow') && shieldDecides.some((o) => o.via === 'shield-deny'),
  JSON.stringify(shieldDecides));
check('5.10c 审计行无 token 全文', auditLines.every((l) => !l.includes('testtoken123')));
A.getDispose()?.();

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
