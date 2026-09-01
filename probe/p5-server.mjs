// probe P5：手机端连通性实测服务器（独立最小 HTTP+SSE 服务，不依赖 DSH）
//
// 测什么（docs/phase-0-spec.md P5）：
//   ① 局域网 IP 与 Tailscale 地址在手机浏览器打开页面（加载成功 = 连通）
//   ② EventSource 建连（页面显示 SSE 状态与耗时）
//   ③ 息屏唤醒后的恢复时延（页面自动记录 visibilitychange → 重连完成 的时间差）
//   ④（顺带承载 P6 终验）页面同时渲染 服务端 SVG 码 + 客户端 canvas 码，扫码应得同一 URL
//
// 运行：node probe/p5-server.mjs
// 日志：probe/results/p5-server.log（服务端请求） + p5-events.jsonl（手机端上报）

// probe 标记：本文件属于阶段 0 探针，不进发布包。

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const PORT = 18790;
const TOKEN = 'probe0123456789abcdef'; // 固定 token 便于验收；生产阶段 1 用随机 token

// 复用 P6 的 vendored QR 库：服务端出 SVG
const req = createRequire(import.meta.url);
const qrcode = req(join(HERE, 'p6-qrcode-generator.js'));

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const size = (n + quiet * 2) * 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${n + quiet * 2} ${n + quiet * 2}" shape-rendering="crispEdges"><rect width="${n + quiet * 2}" height="${n + quiet * 2}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

/** 收集本机 IPv4：局域网段 + Tailscale（100.64/10 CGNAT 段）。 */
function pickAddrs() {
  const lan = [];
  let ts = null;
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const it of ifaces || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(it.address)) ts = it.address;
      else lan.push(it.address);
    }
  }
  return { lan, ts };
}

const serverLog = join(RESULTS, 'p5-server.log');
const eventsLog = join(RESULTS, 'p5-events.jsonl');
const slog = (line) => appendFileSync(serverLog, `${new Date().toISOString()} ${line}\n`);

const sseClients = new Set();
let sseSeq = 0;

const PAGE_HTML = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>mobile-remote 探针 P5</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:12px;padding-bottom:env(safe-area-inset-bottom);background:#111;color:#eee}
  h1{font-size:18px} .card{background:#1d1d1f;border-radius:12px;padding:12px;margin:10px 0}
  .ok{color:#4ade80}.bad{color:#f87171}.muted{color:#9ca3af}
  pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#000;padding:8px;border-radius:8px;max-height:180px;overflow:auto}
  img,canvas{background:#fff;border-radius:8px;width:min(60vw,220px);height:auto}
  .row{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
  button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:15px}
</style>
</head><body>
<h1>📱 mobile-remote 探针 P5/P6</h1>
<div class="card">连接地址：<b id="origin"></b><br><span class="muted" id="via"></span></div>
<div class="card">② SSE 长连接：<span id="sse" class="bad">连接中…</span><br><span class="muted" id="sseDetail"></span>
  <div>收到的探针事件：<span id="count">0</span></div></div>
<div class="card">③ 息屏/回前台记录（自动上报服务器）：<pre id="wakeLog">-</pre></div>
<div class="card">④ 双二维码（应扫出同一地址）：
  <div class="row"><div><p class="muted">服务端 SVG</p><img id="qrSvg" alt="svg 码"></div>
  <div><p class="muted">客户端 canvas</p><canvas id="qrCanvas"></canvas></div></div>
  <p class="muted">扫码结果应均为本页地址（含 token 路径）</p></div>
<div class="card"><button onclick="sendPing()">手动发一个 ping</button> <span id="pingRst" class="muted"></span></div>
<pre id="log"></pre>
<script>
// —— 内联 vendored MIT qrcode-generator（浏览器端渲染 = P6 客户端路线）——
/* __QR_LIB__ */
// —— 页面逻辑 ——
const origin = location.origin;
document.getElementById('origin').textContent = origin + location.pathname;
document.getElementById('via').textContent = '网络接口(自报): ' + (performance.connection?.effectiveType || '未知') + ' · 打开方式: ' + location.pathname;
const logEl = document.getElementById('log'), wakeEl = document.getElementById('wakeLog');
let count = 0, lastDisconnect = 0, reconnectGaps = [];

function log(s){ logEl.textContent = new Date().toLocaleTimeString() + ' ' + s + '\\n' + logEl.textContent; }
function report(ev, data){
  return fetch('/log', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ev, path: location.pathname, t: Date.now(), ...data})}).catch(()=>{});
}

// SSE 建连 + 断线自动重连（指数退避，阶段 1 的重连参数预演）
let es, retry = 1000;
function connectSSE(){
  const t0 = performance.now();
  es = new EventSource('/sse');
  es.onopen = () => {
    const ms = Math.round(performance.now() - t0);
    document.getElementById('sse').textContent = '已连接'; document.getElementById('sse').className = 'ok';
    document.getElementById('sseDetail').textContent = '建连耗时 ' + ms + 'ms';
    if (lastDisconnect) { reconnectGaps.push(Date.now() - lastDisconnect); log('重连完成，断口 ' + (Date.now()-lastDisconnect) + 'ms'); report('sse_reconnect', {gapMs: Date.now() - lastDisconnect, connectMs: ms}); }
    else { log('SSE 首次建连 ' + ms + 'ms'); report('sse_first_connect', {connectMs: ms}); }
    retry = 1000;
  };
  es.onmessage = (e) => { count++; document.getElementById('count').textContent = count; };
  es.onerror = () => {
    document.getElementById('sse').textContent = '断开，' + retry + 'ms 后重试'; document.getElementById('sse').className = 'bad';
    lastDisconnect = Date.now();
    es.close(); setTimeout(connectSSE, retry); retry = Math.min(retry * 2, 10000);
  };
}
connectSSE();

// 息屏/回前台：记录时刻与 SSE 状态（③ 的核心数据）
document.addEventListener('visibilitychange', () => {
  const state = document.visibilityState;
  const entry = new Date().toLocaleTimeString() + ' → ' + state + '（SSE: ' + (es && es.readyState === 1 ? '已连接' : '断开') + '）';
  wakeEl.textContent = entry + '\\n' + wakeEl.textContent;
  log(state === 'visible' ? '回到前台' : '进入后台/息屏');
  report('visibility', {state, sseReadyState: es ? es.readyState : -1});
});

// P6：客户端 canvas 码（同一 vendored 库，浏览器端跑）
(function(){
  try {
    const qr = qrcode(0, 'M'); qr.addData(origin + location.pathname, 'Byte'); qr.make();
    const n = qr.getModuleCount(), canvas = document.getElementById('qrCanvas'), scale = 6, quiet = 4;
    canvas.width = canvas.height = (n + quiet*2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#000';
    for (let r=0;r<n;r++) for (let c=0;c<n;c++) if (qr.isDark(r,c)) ctx.fillRect((c+quiet)*scale,(r+quiet)*scale,scale,scale);
  } catch(e){ log('客户端 QR 失败: ' + e.message); }
})();
document.getElementById('qrSvg').src = '/qr.svg?u=' + encodeURIComponent(origin + location.pathname);

async function sendPing(){
  const t0 = performance.now();
  const r = await fetch('/ping', {method:'POST'});
  document.getElementById('pingRst').textContent = 'RTT ' + Math.round(performance.now()-t0) + 'ms';
  report('ping', {rttMs: Math.round(performance.now()-t0)});
}
report('page_loaded', {ua: navigator.userAgent});
log('页面加载完成（' + origin + '）');
</script>
</body></html>`;

// 把 vendored QR 库内联进页面（浏览器端全局 qrcode）——P6 客户端路线
const qrLibSource = readFileSync(join(HERE, 'p6-qrcode-generator.js'), 'utf8');
// 库尾部 UMD 工厂依赖 module/exports（CJS），浏览器内联时剥掉，保留全局 var qrcode
const qrLibBrowser = qrLibSource.replace(/\(function \(factory\) \{[\s\S]*$/, '');
const page = PAGE_HTML.replace('/* __QR_LIB__ */', () => qrLibBrowser); // 函数形式避免 $ 序列被解释

const { lan, ts } = pickAddrs();

const server = createServer((reqst, res) => {
  const url = new URL(reqst.url, 'http://x');
  slog(`${reqst.method} ${url.pathname} from ${reqst.socket.remoteAddress}`);
  if (reqst.method === 'POST' && url.pathname === '/log') {
    let body = '';
    reqst.on('data', (c) => { body += c; });
    reqst.on('end', () => {
      try { appendFileSync(eventsLog, JSON.stringify({ receivedAt: new Date().toISOString(), remote: reqst.socket.remoteAddress, ...JSON.parse(body) }) + '\n'); } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (reqst.method === 'POST' && url.pathname === '/ping') { res.writeHead(200); res.end('pong'); return; }
  if (url.pathname === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
    sseClients.add(res);
    const id = ++sseSeq;
    slog(`SSE client #${id} connected (total ${sseClients.size})`);
    res.write(`event: hello\ndata: {"client":${id},"serverTime":${Date.now()}}\n\n`);
    const hb = setInterval(() => {
      try { res.write(`data: {"hb":${Date.now()}}\n\n`); } catch {}
    }, 15000);
    reqst.on('close', () => { clearInterval(hb); sseClients.delete(res); slog(`SSE client #${id} closed (total ${sseClients.size})`); });
    return;
  }
  if (url.pathname === '/qr.svg') {
    const target = url.searchParams.get('u') || `http://LAN:${PORT}/t/${TOKEN}`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end(qrSvg(target));
    return;
  }
  if (url.pathname === '/' || url.pathname === `/t/${TOKEN}`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }
  if (url.pathname === '/t/wrong-token') { res.writeHead(401); res.end('token 不对（模拟错误 token 行为）'); return; }
  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    `P5 服务器已启动（0.0.0.0:${PORT}），token 路径 /t/${TOKEN}`,
    ...lan.map((ip) => `  局域网:   http://${ip}:${PORT}/t/${TOKEN}`),
    ...(ts ? [`  Tailscale: http://${ts}:${PORT}/t/${TOKEN}`] : ['  Tailscale: 未检测到（100.x 网段无地址）']),
    `手机打开上面任一地址即可；事件日志写 ${eventsLog}`,
  ];
  console.log(lines.join('\n'));
  slog(lines.join(' | '));
  writeFileSync(join(RESULTS, 'p5-urls.txt'), lines.join('\n'));
});
