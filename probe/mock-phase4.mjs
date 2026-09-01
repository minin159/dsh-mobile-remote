/**
 * 阶段 4 UI 走查用 mock 服务器（probe/mock-phase4.mjs，不进发布）：
 * 真实 page.html + 假 API——35 个会话（多 cwd + 未分组）、SSE 推流
 * （hello / markdown 表格消息 / tool/call 流式），供浏览器实测首页卡片、
 * 会话视图渲染、当前动作 pill 与 ↓FAB。
 * 运行：node probe/mock-phase4.mjs  →  http://127.0.0.1:3199/mobile-remote/p/testtoken
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const TOKEN = 'testtoken';

// ── mock 会话数据：4 组 35 个（含一个无 cwd「未分组」）─────────────────────
const now = Date.now();
const min = 60 * 1000, hour = 3600 * 1000, day = 86400 * 1000;
const cwdA = 'D:\\edge\\GLM';
const cwdB = 'D:\\dsh-plugins\\mobile-remote';
const cwdC = 'D:\\tools\\deploy-scripts';
const sessions = [];
function add(id, cwd, title, opts = {}) {
  const i = sessions.length;
  sessions.push({
    id,
    createdAt: now - (i + 3) * day,
    cwd,
    live: opts.live !== false,
    persisted: opts.persisted === true,
    title: title || '',
    status: opts.status || 'idle',
    humanAt: now - (i + 1) * hour,
    lastAt: now - i * 17 * min,
    bound: opts.bound === true,
  });
}
for (let i = 0; i < 12; i++) add('session-aaaa-' + i, cwdA, i === 0 ? '阶段 4 UI 2.0 实现：首页工作区卡片' : '', i === 0 ? { status: 'running', bound: true } : {});
for (let i = 0; i < 15; i++) add('session-bbbb-' + i, cwdB, i === 0 ? 'mobile-remote 阶段 2 完整对齐' : '', i === 0 ? { persisted: true, live: false } : {});
for (let i = 0; i < 5; i++) add('session-cccc-' + i, cwdC, '', i === 1 ? { status: 'done' } : i === 2 ? { status: 'error' } : {});
for (let i = 0; i < 3; i++) add('session-dddd-' + i, '', '', { persisted: true, live: false });

// ── SSE 推流脚本：建连后依次推 hello / 流式回合（表格+行内代码+工具）──────
const TABLE_MD = [
  '对齐结果如下：',
  '',
  '| 模块 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| 首页卡片 | ✅ 完成 | cwd 分组 + 折叠 |',
  '| 表格渲染 | ✅ 完成 | 受控 DOM |',
  '| 底栏控件 | ⏳ 阶段 5 | 不在本阶段 |',
  '',
  '详见 `phase-4-spec.md` 与 `roadmap.md`。',
].join('\n');

let seq = 100;
function frame(type, data) {
  seq += 1;
  return { id: seq, text: `id: ${seq}\nevent: session\ndata: ${JSON.stringify({ seq, type, data })}\n\n` };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  console.log('[mock]', req.method, path);
  if (path === '/mobile-remote/p/' + TOKEN) {
    const html = readFileSync(join(ROOT, 'web', 'page.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (path === '/mobile-remote/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions, boundSession: 'session-aaaa-0', pinnedSession: 'session-aaaa-0' }));
    return;
  }
  if (path === '/mobile-remote/paircheck') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/mobile-remote/switch' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const sid = JSON.parse(body || '{}').sessionId || '';
      for (const s of sessions) s.bound = s.id === sid;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: sid || 'session-aaaa-0', cwd: sid ? (sessions.find((s) => s.id === sid)?.cwd || '') : cwdA, live: true }));
      // 切换成功后推 bound + 一条演示消息（模拟服务器补发近期帧）
      if (pusher) {
        pusher(`event: bound\ndata: ${JSON.stringify({ sessionId: sid || 'session-aaaa-0', cwd: cwdA, switched: true, live: true })}\n\n`);
        const f1 = frame('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '看一下渲染效果' }] });
        pusher(f1.text);
        const f2 = frame('assistant/message', { turn: 9, step: 1, message: { content: [{ type: 'text', text: TABLE_MD }] } });
        setTimeout(() => pusher(f2.text), 300);
      }
    });
    return;
  }
  if (path === '/mobile-remote/send' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      if (pusher) {
        const text = JSON.parse(body || '{}').text || '';
        const f0 = frame('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
        pusher(f0.text);
      }
    });
    return;
  }
  if (path === '/mobile-remote/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    pusher = (t) => { try { res.write(t); } catch {} };
    res.write(`event: hello\ndata: ${JSON.stringify({ sessionId: 'session-aaaa-0', cwd: cwdA, status: 'running', waitSec: 120, throttleSec: 2, seq, epoch: 'mock-epoch' })}\n\n`);
    // 流式回合：tool/call → chunk → 最终消息（markdown 表格 + 行内代码 + 代码块）
    let n = 0;
    streamTimer = setInterval(() => {
      n += 1;
      if (n === 1) {
        pusher(frame('tool/call', { callId: 'c1', name: 'Read', arguments: { file_path: 'D:\\edge\\GLM\\web\\page.html', limit: 50 } }).text);
      } else if (n === 2) {
        pusher(frame('assistant/chunk', { turn: 5, step: 1, chunk: { type: 'text-delta', text: '正在核对渲染' } }).text);
      } else if (n === 3) {
        pusher(frame('tool/result', { message: { callId: 'c1', isError: false } }).text);
      } else if (n === 4) {
        const f = frame('assistant/message', {
          turn: 5, step: 1,
          message: { content: [{ type: 'text', text: TABLE_MD + '\n\n```js\nconsole.log("hello");\n```\n\n完成。' }] },
        });
        pusher(f.text);
      } else {
        clearInterval(streamTimer);
      }
    }, 1500);
    // 心跳
    hbTimer = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now(), seq })}\n\n`);
    }, 15000);
    req.on('close', () => { clearInterval(streamTimer); clearInterval(hbTimer); pusher = null; });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});

let pusher = null;
let streamTimer = null;
let hbTimer = null;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] ready → http://127.0.0.1:${PORT}/mobile-remote/p/${TOKEN}`);
});
