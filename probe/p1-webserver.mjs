// probe P1：DSH webServer 服务能力实测（独立运行，不经 DSH 应用、不碰用户实例）
//
// 目标（docs/phase-0-spec.md P1）：
//   ① 能否前缀/多路径注册（kind:'prefix' / 多个 exact）
//   ② 能否升级/托管 WebSocket（registerUpgrade + 手写 RFC6455 握手/帧）
//   ③ 返回 HTML/静态内容的方式与 Content-Type 控制
// 附带：SSE 可行性（降级通道）、重复注册冲突、404 行为、handler 抛错行为。
//
// 方法：用与宿主完全相同的 @deepseek-ai/dsh-host-webserver（取自宿主 node_modules，
//       只读引用）在独立 Cordis 上下文装配；接线方式复刻 phone-push 已验证的
//       ctx.inject(['webServer'], ...) 用法。客户端用 node 内置 fetch 与全局
//       WebSocket，零第三方依赖。
//
// 运行：node probe/p1-webserver.mjs
// 结果：控制台逐项 PASS/FAIL + probe/p1-result.json

// probe 标记：本文件属于阶段 0 探针，不进发布包。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_TREE = 'C:/Users/lq/.dsh/profiles/node_modules/@deepseek-ai';

/** 从宿主包树按真实路径加载（各包内部依赖经自身 node_modules 上溯解析）。 */
async function loadHostModule(pkgPath) {
  return import(pathToFileURL(join(HOST_TREE, pkgPath)).href);
}

const { Context } = await loadHostModule('cordis/lib/index.js');
const { WebServer } = await loadHostModule('dsh-host-webserver/lib/index.js');

const PORT = 18791; // probe 专用端口，避开宿主 3080/ntfy 2580
const BASE = `http://127.0.0.1:${PORT}`;

// ── 测试结果收集 ──────────────────────────────────────────────────────────────
const results = [];
function record(id, name, pass, evidence) {
  results.push({ id, name, verdict: pass ? 'PASS' : 'FAIL', evidence: String(evidence) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} — ${evidence}`);
}

// ── 装配：宿主同款 WebServer 服务 + phone-push 同款接线 ────────────────────────
const registered = { routes: 0, upgrade: false };

const ctx = new Context();
ctx.plugin(WebServer, { host: '127.0.0.1', port: PORT });

const ready = new Promise((resolveReady) => {
  // 与 phone-push dsh/index.js 相同的注入方式：等待服务就绪后在 effect 内注册。
  ctx.inject(['webServer'], (scope) => {
    const ws = scope.webServer;

    // ③ Content-Type 控制：JSON、HTML、SSE 各自显式设置
    ws.register({
      kind: 'exact',
      path: '/probe/exact',
      handler: async (req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Probe', 'exact-1');
        res.end(JSON.stringify({ ok: true, url: req.url, method: req.method, headerEcho: req.headers['x-client-echo'] ?? null }));
      },
    });

    // ① 多条 exact 路由并存
    ws.register({
      kind: 'exact',
      path: '/probe/exact2',
      handler: async (_req, res) => {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('exact-2-ok');
      },
    });

    // ① 前缀路由：应同时命中 /probe/prefix 本身与更深层路径
    ws.register({
      kind: 'prefix',
      path: '/probe/prefix',
      handler: async (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, matchedPrefix: true, url: req.url }));
      },
    });

    // ③ HTML 页面（移动端单页的托管形态预演）
    ws.register({
      kind: 'exact',
      path: '/probe/page',
      handler: async (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>probe</title></head><body><h1>P1 页面托管 OK</h1><p>inline HTML</p></body></html>');
      },
    });

    // 降级通道预演：SSE（text/event-stream），推 3 条事件后保持打开
    const sseClients = new Set();
    ws.register({
      kind: 'exact',
      path: '/probe/sse',
      handler: async (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        let n = 0;
        const send = () => {
          n += 1;
          res.write(`id: ${n}\nevent: probe\ndata: {"n":${n}}\n\n`);
          if (n >= 3) clearInterval(timer);
        };
        const timer = setInterval(send, 120);
        send();
        sseClients.add(res);
        req.on('close', () => {
          clearInterval(timer);
          sseClients.delete(res);
        });
      },
    });

    // ② WebSocket：手写 RFC6456 握手 + 最小文本帧回显（服务端零依赖）
    ws.registerUpgrade({
      path: '/probe/ws',
      handler: (req, socket, head) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) {
          socket.destroy();
          return;
        }
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        registered.upgrade = true;
        let buf = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          // 逐帧解析：只要文本帧（opcode 1），客户端帧必带掩码
          while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) !== 0;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
              if (buf.length < 4) return;
              len = buf.readUInt16BE(2);
              off = 4;
            } else if (len === 127) {
              if (buf.length < 10) return;
              len = Number(buf.readBigUInt64BE(2));
              off = 10;
            }
            const maskLen = masked ? 4 : 0;
            if (buf.length < off + maskLen + len) return;
            const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
            if (masked) {
              const mask = buf.subarray(off, off + 4);
              for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            buf = buf.subarray(off + maskLen + len);
            if (opcode === 0x8) {
              socket.end();
              return;
            }
            if (opcode === 0x1) {
              // 回显为服务器→客户端文本帧（服务器帧不掩码；<126 用 2 字节头，<65536 用 4 字节头）
              const body = Buffer.from(payload);
              let header;
              if (body.length < 126) {
                header = Buffer.from([0x81, body.length]);
              } else {
                header = Buffer.from([0x81, 126, 0, 0]);
                header.writeUInt16BE(body.length, 2);
              }
              socket.write(Buffer.concat([header, body]));
            }
          }
        });
      },
    });

    // 404 行为：未注册 fallback 时应 404（生产中 SPA dist 占据 fallback，前缀路由优先于 fallback）
    registered.routes = 4;
    resolveReady();
  });
});

await ready;
console.log(`webServer listening on ${BASE}（routes=${registered.routes} upgrade=${registered.upgrade}）`);

// ── 客户端逐项验证 ────────────────────────────────────────────────────────────
const j = async (path, opts) => {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, body };
};

try {
  const a = await j('/probe/exact', { headers: { 'x-client-echo': 'hello' } });
  record('P1.1', 'exact 路由 + JSON + 自定义头/透传', a.status === 200 && a.body?.ok === true && a.headers.get('x-probe') === 'exact-1' && a.body.headerEcho === 'hello',
    `status=${a.status} content-type=${a.headers.get('content-type')} x-probe=${a.headers.get('x-probe')} echo=${a.body.headerEcho}`);
} catch (e) { record('P1.1', 'exact 路由', false, e.message); }

try {
  const b = await j('/probe/exact2');
  record('P1.2', '多条 exact 路由并存', b.status === 200 && b.body === 'exact-2-ok', `status=${b.status} body=${b.body}`);
} catch (e) { record('P1.2', '多条 exact', false, e.message); }

try {
  const c1 = await j('/probe/prefix');
  const c2 = await j('/probe/prefix/aaa/bbb');
  record('P1.3', "kind:'prefix' 前缀路由（含深层路径）", c1.status === 200 && c1.body?.matchedPrefix === true && c2.status === 200 && c2.body?.matchedPrefix === true,
    `/probe/prefix → ${c1.status}; /probe/prefix/aaa/bbb → ${c2.status}`);
} catch (e) { record('P1.3', '前缀路由', false, e.message); }

try {
  const d = await fetch(BASE + '/probe/page');
  const html = await d.text();
  record('P1.4', 'HTML 页面返回 + Content-Type', d.status === 200 && d.headers.get('content-type').includes('text/html') && html.includes('<h1>'),
    `status=${d.status} content-type=${d.headers.get('content-type')} bytes=${html.length}`);
} catch (e) { record('P1.4', 'HTML 页面', false, e.message); }

try {
  const ac = new AbortController();
  const sse = await fetch(BASE + '/probe/sse', { signal: ac.signal });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const t0 = Date.now();
  while (!text.includes('{"n":3}')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    if (Date.now() - t0 > 5000) break;
  }
  ac.abort();
  const events = (text.match(/event: probe/g) || []).length;
  record('P1.5', 'SSE（text/event-stream 流式推送）', sse.status === 200 && sse.headers.get('content-type').includes('text/event-stream') && events >= 3,
    `status=${sse.status} content-type=${sse.headers.get('content-type')} 收到事件=${events}`);
} catch (e) { record('P1.5', 'SSE', false, e.message); }

try {
  const wsUrl = `ws://127.0.0.1:${PORT}/probe/ws`;
  const sock = new WebSocket(wsUrl);
  const echoed = await new Promise((resolvePromise) => {
    const got = [];
    const timer = setTimeout(() => resolvePromise(got), 3000);
    sock.onopen = () => sock.send('probe-msg-1');
    sock.onmessage = (ev) => {
      got.push(String(ev.data));
      if (got.length === 1) sock.send('probe-msg-2');
      if (got.length === 2) { clearTimeout(timer); resolvePromise(got); }
    };
    sock.onerror = () => { clearTimeout(timer); resolvePromise(got); };
  });
  try { sock.close(); } catch {}
  record('P1.6', 'WebSocket 升级（registerUpgrade + 手写握手/帧）', echoed[0] === 'probe-msg-1' && echoed[1] === 'probe-msg-2',
    `echo=${JSON.stringify(echoed)}`);
} catch (e) { record('P1.6', 'WebSocket 升级', false, e.message); }

try {
  const f = await j('/probe/not-registered');
  record('P1.7', '未匹配路由 → 404（fallback 未占用时）', f.status === 404, `status=${f.status}`);
} catch (e) { record('P1.7', '404 行为', false, e.message); }

// 重复注册应抛错（具名路由互不相交的组合约定）
try {
  let threw = false;
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.webServer.register({ kind: 'exact', path: '/probe/exact', handler: async () => {} });
    } catch {
      threw = true;
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  record('P1.8', '重复路径注册抛错（路由冲突即配置错误）', threw, threw ? 'register() 抛 duplicate route 错误' : '未抛错');
} catch (e) { record('P1.8', '重复注册', false, e.message); }

// handler 抛错 → 服务端 400 且进程不退（README 约定，实测确认）
try {
  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'exact',
      path: '/probe/boom',
      handler: async () => { throw new Error('probe-intentional'); },
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  const g = await j('/probe/boom');
  record('P1.9', 'handler 抛错 → 400、进程存活', g.status === 400, `status=${g.status}`);
} catch (e) { record('P1.9', 'handler 抛错', false, e.message); }

// 汇总落盘
const outPath = join(HERE, 'p1-result.json');
writeFileSync(outPath, JSON.stringify({ port: PORT, at: new Date().toISOString(), results }, null, 2));
const pass = results.filter((r) => r.verdict === 'PASS').length;
console.log(`\nP1 完成：${pass}/${results.length} PASS；结果已写 ${outPath}`);
process.exit(0);
