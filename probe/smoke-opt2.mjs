/**
 * 优2 冒烟测试（probe/smoke-opt2.mjs）：模型切换真控件——/model 目录+切换路由、
 * 官方 selectModel 调用契约、审计、能力位显隐。运行：node probe/smoke-opt2.mjs。
 * P8 结论回归点：切换只走 sessionController.selectModel（官方路径）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 审计文件写入一次性临时目录（os.homedir 在 Windows 读 USERPROFILE）
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'mr-smokeo2-'));

// dsh-llm stub（供 /send 链路，不影响 /model 的 ctx.get('llm') mock）
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
      if (name === 'llm') return world.llm || null;
      if (name === 'sessionController') return world.sessionController || null;
      if (name === 'agents') {
        return {
          roots: () => world.liveSessions.map((s) => ({ session: { header: { id: s.header.id, createdAt: s.header.createdAt, cwd: s.header.cwd } } })),
          get: (sid) => ({
            steer: (msg) => world.steered.push({ sid, msg }),
            session: { requestHeader: () => (world.requestHeader ? world.requestHeader() : {}) },
          }),
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
  return res;
}

function jsonOf(res) { try { return JSON.parse(res.body()); } catch { return null; } }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail ? '—— ' + detail : ''); }
}

function auditActs() {
  const p = join(process.env.USERPROFILE, '.dsh', 'mobile-remote-audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const liveSessions = [{ header: { id: 'session-aaa1', createdAt: Date.now() - 3600e3, cwd: 'D:\\proj-a' } }];
const world = {
  liveSessions,
  steered: [],
  requestHeader: () => ({ config: { provider: 'zai-coding-cn', model: 'GLM-5.3-flash' } }),
  // 官方 llm 服务 mock：listProviders/listModels（含对象与字符串两种条目形态，测防御映射）
  llm: {
    listProviders: async () => [{ id: 'zai-coding-cn', name: '智谱 Coding' }, { id: 'deepseek-official' }],
    listModels: async (provider) => provider === 'zai-coding-cn'
      ? [{ id: 'GLM-5.3-flash', name: 'GLM-5.3 Flash' }, 'GLM-4.7-Flash']
      : [],
  },
  sessionController: {
    selectModel: async (req) => {
      world.selectCalls.push(req);
      if (req.model === 'BAD-MODEL') throw new Error('model-unavailable: no such model');
      return { selected: { provider: req.provider, model: req.model } };
    },
  },
};
world.selectCalls = [];

console.log('\n[O2] 模型切换真控件');
const A = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));

// O2.1 页面形态：模型键 + 弹层 + 当前模型行/副作用明示
let res = mockRes();
await A.prefixes.find((p) => p.path === '/mobile-remote').handler(mockReq('/mobile-remote/p/testtoken123'), res);
const page = res.body();
check('O2.1a 页面含模型键/弹层/当前行/副作用明示', page.includes('id="modelBtn"') && page.includes('id="modelSheet"')
  && page.includes('id="modelCur"') && page.includes('id="modelNote"') && page.includes('id="modelCancel"'));
check('O2.1b 弹层说明含下一回合生效与全局默认明示', page.includes('下一回合生效') && page.includes('默认模型'));

// 建连绑定会话（bindSession 走 pickSession）
const sseReq = mockReq('/mobile-remote/sse?token=testtoken123');
const sseRes = mockRes();
await A.routes.get('/mobile-remote/sse')(sseReq, sseRes);
check('O2.1c SSE 建连绑定 aaa1', sseRes.statusCode === 200 && sseRes.body().includes('session-aaa1'));

// O2.2 /sessions 带 canModel 能力位
res = mockRes();
await A.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), res);
check('O2.2 sessions canModel=true', jsonOf(res)?.canModel === true, res.body());

// O2.3 GET /model：目录分组 + 当前模型（requestHeader 同源）
res = mockRes();
await A.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model?token=testtoken123'), res);
const md = jsonOf(res);
check('O2.3a GET /model ok + canSwitch', md?.ok === true && md?.canSwitch === true, res.body());
check('O2.3b 当前模型读自 requestHeader', md?.current?.provider === 'zai-coding-cn' && md?.current?.model === 'GLM-5.3-flash', JSON.stringify(md?.current));
check('O2.3c 目录两供应商且模型条目形状归一', md?.providers?.length === 2
  && md.providers[0].id === 'zai-coding-cn' && md.providers[0].name === '智谱 Coding'
  && md.providers[0].models.length === 2
  && md.providers[0].models[0].id === 'GLM-5.3-flash' && md.providers[0].models[0].name === 'GLM-5.3 Flash'
  && md.providers[0].models[1].id === 'GLM-4.7-Flash' && md.providers[0].models[1].name === 'GLM-4.7-Flash',
  JSON.stringify(md?.providers));
check('O2.3d 空目录供应商保留组但模型为空', md?.providers?.[1]?.id === 'deepseek-official' && md.providers[1].models.length === 0);

// O2.4 POST /model：官方 selectModel 契约 + 审计
res = mockRes();
await A.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model', 'POST', { token: 'testtoken123', provider: 'zai-coding-cn', model: 'GLM-4.7-Flash' }), res);
check('O2.4a 切换 200 + selected 回显', jsonOf(res)?.ok === true
  && jsonOf(res)?.selected?.model === 'GLM-4.7-Flash', res.body());
check('O2.4b selectModel 收到 sessionId+provider+model', world.selectCalls.length === 1
  && world.selectCalls[0].sessionId === 'session-aaa1'
  && world.selectCalls[0].provider === 'zai-coding-cn'
  && world.selectCalls[0].model === 'GLM-4.7-Flash', JSON.stringify(world.selectCalls));
await new Promise((r) => setTimeout(r, 80));
let acts = auditActs().filter((a) => a.act === 'model_switch');
check('O2.4c 审计 model_switch 含 from/to', acts.length === 1
  && acts[0].from === 'zai-coding-cn/GLM-5.3-flash' && acts[0].to === 'zai-coding-cn/GLM-4.7-Flash'
  && acts[0].sid === 'session-aaa1', JSON.stringify(acts));

// O2.5 官方校验拒绝 → 502 switch-failed + 宿主消息透传 + 审计 ok:false
res = mockRes();
await A.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model', 'POST', { token: 'testtoken123', provider: 'zai-coding-cn', model: 'BAD-MODEL' }), res);
check('O2.5a 非法模型 502 + 消息透传', res.statusCode === 502 && jsonOf(res)?.code === 'switch-failed'
  && String(jsonOf(res)?.message || '').includes('no such model'), res.body());
await new Promise((r) => setTimeout(r, 80));
acts = auditActs().filter((a) => a.act === 'model_switch');
check('O2.5b 失败也写审计（ok:false）', acts.length === 2 && acts[1].ok === false, JSON.stringify(acts));

// O2.6 参数防御：空 model 400
res = mockRes();
await A.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model', 'POST', { token: 'testtoken123', provider: 'zai-coding-cn' }), res);
check('O2.6 缺 model 400 bad-model', res.statusCode === 400 && jsonOf(res)?.code === 'bad-model');

// O2.7 无 sessionController：canModel=false、canSwitch=false、POST 501（不静默）
const B = buildCtx({ enabled: true, token: 'testtoken123', relayPort: 0 }, { ...world, sessionController: null });
await new Promise((r) => setTimeout(r, 30));
await B.routes.get('/mobile-remote/sse')(mockReq('/mobile-remote/sse?token=testtoken123'), mockRes());
res = mockRes();
await B.routes.get('/mobile-remote/sessions')(mockReq('/mobile-remote/sessions?token=testtoken123'), res);
check('O2.7a 无控制器 canModel=false', jsonOf(res)?.canModel === false);
res = mockRes();
await B.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model?token=testtoken123'), res);
check('O2.7b GET /model canSwitch=false 但目录仍可读', jsonOf(res)?.canSwitch === false
  && jsonOf(res)?.providers?.length === 2);
res = mockRes();
await B.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model', 'POST', { token: 'testtoken123', provider: 'p', model: 'm' }), res);
check('O2.7c POST /model 501 switch-unavailable', res.statusCode === 501 && jsonOf(res)?.code === 'switch-unavailable', res.body());

// O2.8 读不到会话模型 → current=null（前端显示"跟随默认"）
world.requestHeader = () => { throw new Error('gone'); };
res = mockRes();
await A.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model?token=testtoken123'), res);
check('O2.8 requestHeader 异常 → current=null', jsonOf(res)?.current === null, res.body());

// O2.9 停用态 404
const C = buildCtx({ enabled: false, token: 'testtoken123', relayPort: 0 }, world);
await new Promise((r) => setTimeout(r, 30));
res = mockRes();
await C.routes.get('/mobile-remote/model')(mockReq('/mobile-remote/model?token=testtoken123'), res);
check('O2.9 停用 GET 404', res.statusCode === 404);

A.getDispose?.();
B.getDispose?.();
C.getDispose?.();
console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
