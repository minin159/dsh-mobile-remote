/**
 * mobile-remote — 单会话远程控制（DSH Cordis 插件，阶段 1 MVP）
 *
 * 手机扫码/开链接 → 实时看当前 DSH 会话流、发消息（steer）、审批权限请求。
 * 选型依据 docs/probe-findings.md（阶段 0 实测，不再重新推导）：
 *   - 通道：SSE（EventSource）+ POST 控制接口；页面走 prefix 路由内联返回（P1）。
 *   - 审批：混合回落——插件决策即终局（GUI 不再弹）；插件自带超时（默认 120s），
 *     到点 next() 交回电脑端 GUI；宿主无默认超时，不响应会永久阻塞（P3）。
 *   - 会话标识：session/event 的 subject.header.id；agent 句柄可从
 *     agents 服务按 sessionId 解析（P2/P4；冷启动绑定也走这条路）。
 *   - 部署前提：生产 DSH web 默认只绑 127.0.0.1:3080，手机可达必须
 *     `dsh web --host 0.0.0.0` 启动（P5）。
 *
 * HTTP 路由（全部挂在本插件的 /mobile-remote/ 命名空间下）：
 *   exact  /mobile-remote/api       设置页数据接口（仅限电脑回环访问）
 *   exact  /mobile-remote/sse       手机长连接（?token=<配对码>&since=<上次事件号>）
 *   exact  /mobile-remote/send      手机发消息（POST {token,text} → agent.steer）
 *   exact  /mobile-remote/approve   手机审批（POST {token,id,decision}）
 *   exact  /mobile-remote/sessions  会话列表（阶段 2，GET ?token=）
 *   exact  /mobile-remote/switch    切换绑定会话（阶段 2，POST {token,sessionId}）
 *   prefix /mobile-remote/          移动端单页（/p/<token>，token 即路径段，错码 401）
 *
 * 安全模型：
 *   - token 即密码：随机 32 位 hex，只在配对 URL / 查询参数 / 请求体中出现，
 *     日志一律打码；校验用 timingSafeEqual 防时序侧信道。
 *   - 单连接绑定：同一时刻只保留一台手机的活动连接，新连接顶替旧连接并通知。
 *   - 设置接口仅限电脑回环（Host 校验 + Origin 校验），手机侧只拿 token 接口。
 *   - 「停止远程」一键断开所有手机连接，挂起的审批立即回落电脑端。
 *
 * 零影响承诺：enabled=false（默认）时不拦截审批（直接 next()）、不转发事件，
 * 路由虽然注册但对 DSH 其他功能零干扰。
 */

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createServer as createRelayServer, request as httpRequest } from 'node:http';

export const name = 'mobile-remote';

/** 本插件不注册模型常驻工具以外的服务依赖；工具注册表用于自测工具。 */
export const inject = ['tools'];

const ROUTE_API = '/mobile-remote/api';
const ROUTE_SSE = '/mobile-remote/sse';
const ROUTE_SEND = '/mobile-remote/send';
const ROUTE_APPROVE = '/mobile-remote/approve';
const ROUTE_SESSIONS = '/mobile-remote/sessions';
const ROUTE_SWITCH = '/mobile-remote/switch';
const ROUTE_PREFIX = '/mobile-remote/';

const PLUGIN_TAG = '[mobile-remote]';

/** 设置默认值（settings 命名空间未就绪时的兜底，与 schema 默认一致）。 */
const DEFAULTS = {
  enabled: false,
  publicBase: '',
  token: '',
  approvalWaitSec: 120, // 手机审批等待窗口；超时 next() 回落电脑端 GUI
  sendThrottleSec: 2,   // 发送节流（防连点，UI 同步用）
  relayPort: 3090,      // 手机中继监听端口（0.0.0.0）；DSH web 本体保持回环
};

/** 环形缓冲上限：每会话缓存最近 200 条转发帧，供断线/整页重载/切换会话后补发。 */
const RING_CAP = 200;
/** 环形缓冲最多追踪的会话数（阶段 2 起所有根会话都入缓冲，上限放宽到 16）。 */
const RING_SESSIONS = 16;
/** 活动追踪表上限（session/activity 状态，防膨胀）。 */
const ACTIVITY_CAP = 32;
/** 单帧体积上限：超过则只转发/缓存"已截断"占位（正文已由 assistant/chunk 增量送达）。 */
const FRAME_CAP = 16 * 1024;
/** 手机审批同时挂起上限（防御性，超过直接交回电脑端）。 */
const PENDING_CAP = 4;
/** 手机断开后的宽限时长：期间不立即回落审批，等整页重载回来（P5：安卓息屏回前台走整页重载）。 */
const DISCONNECT_GRACE_MS = 10 * 1000;
/** SSE 心跳间隔（注释行，浏览器端无感知，保活代理/ NAT）。 */
const HEARTBEAT_MS = 15 * 1000;

function msgOf(error) {
  return error && error.message ? error.message : String(error);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** token 打码：日志只出现首 4 位 + 末 2 位。 */
function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 8) return '***';
  return t.slice(0, 4) + '…' + t.slice(-2);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 事件载荷防御式提取会话 id（载荷形状多样，参照 phone-push 同款兜底链）。 */
function extractSessionId(payload) {
  try {
    const agent = payload && typeof payload === 'object' ? payload.agent : undefined;
    const session = payload?.session || agent?.session;
    const sid = session?.header?.id || payload?.sessionId || session?.id || agent?.id;
    return sid !== undefined ? String(sid) : undefined;
  } catch {
    return undefined;
  }
}

// @deepseek-ai/dsh-llm 的 createUserMessage：构造 agent.steer() 所需的 UserMessage。
let llmCache;
async function loadLlm() {
  if (llmCache) return llmCache;
  const req = createRequire(process.argv[1] || import.meta.url);
  const resolved = req.resolve('@deepseek-ai/dsh-llm');
  llmCache = await import(pathToFileURL(resolved).href);
  return llmCache;
}

// schemastery 加载：插件以 link 形式装在 profile 外，裸说明符解析不到宿主包，
// 退回从运行中的 dsh 入口锚定解析（phone-push 同款两级策略）。
let zCache;
async function loadZ() {
  if (zCache) return zCache;
  try {
    zCache = (await import('@deepseek-ai/schemastery')).default;
    if (zCache) return zCache;
  } catch {}
  try {
    const req = createRequire(process.argv[1] || import.meta.url);
    const resolved = req.resolve('@deepseek-ai/schemastery');
    zCache = (await import(pathToFileURL(resolved).href)).default;
    return zCache;
  } catch (error) {
    console.error(PLUGIN_TAG, 'cannot load schemastery:', msgOf(error));
    return null;
  }
}

/** 生成本轮运行 401 独立提示页（不含任何敏感信息）。 */
function errorPage(title, detail) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#111318;color:#e5e7eb}
.box{max-width:22rem;padding:2rem;text-align:center;line-height:1.6}.box h1{font-size:1.1rem}.box p{color:#9ca3af;font-size:.9rem;white-space:pre-wrap}</style>
</head><body><div class="box"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}

/** 加载移动端单页模板（web/page.html，随插件发布；读取一次后缓存）。 */
function loadPageTemplate() {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(join(here, 'web', 'page.html'), 'utf8');
  } catch (error) {
    console.error(PLUGIN_TAG, 'web/page.html 读取失败，移动端页面降级为提示页:', msgOf(error));
    return errorPage('页面资源缺失', 'web/page.html 未随插件安装，请检查插件目录完整性。');
  }
}

/** 收集本机 IPv4（局域网 + Tailscale 100.64/10 段），供设置页地址建议。 */
function pickLanAddrs() {
  const lan = [];
  const tailscale = [];
  try {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const it of ifaces || []) {
        if (it.family !== 'IPv4' || it.internal) continue;
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(it.address)) tailscale.push(it.address);
        else lan.push(it.address);
      }
    }
  } catch {}
  return { lan, tailscale };
}

export function apply(ctx, config) {
  const seed = config && typeof config === 'object' ? config : {};

  // ── 设置命名空间（applies:'live'：改动热生效、持久化，无需重启）──────────
  // 结构沿用 phone-push 已验证的函数式注入 + schemastery 形态。
  let settingsHandle = null;
  const ready = new Promise((resolveReady) => {
    if (typeof ctx.inject !== 'function') {
      console.log(PLUGIN_TAG, 'no inject capability; running with defaults');
      resolveReady(null);
      return;
    }
    ctx.inject(['settings'], (scope) => {
      (async () => {
        try {
          if (scope && scope.settings) {
            const z = await loadZ();
            if (z) {
              settingsHandle = scope.settings.register('mobile-remote', buildSchema(z, seed), { applies: 'live' });
              console.log(PLUGIN_TAG, 'settings namespace registered');
            } else {
              console.log(PLUGIN_TAG, 'schemastery unavailable; running with defaults (no settings card)');
            }
          } else {
            console.log(PLUGIN_TAG, 'settings service absent; running with defaults');
          }
        } catch (error) {
          console.error(PLUGIN_TAG, 'settings bootstrap failed:', msgOf(error));
        } finally {
          resolveReady(settingsHandle);
        }
      })();
    });
  });

  function buildSchema(z, seedConfig) {
    const s = seedConfig && typeof seedConfig === 'object' ? seedConfig : {};
    return z.object({
      enabled: z.boolean().default(false),
      // 手机侧可达的对外地址（如 http://192.168.10.10:3090 或 Tailscale 地址）；
      // 空 = 设置页用自动探测的局域网地址 + 中继端口拼配对链接。
      publicBase: z.string().default(typeof s.publicBase === 'string' ? s.publicBase.trim().replace(/\/+$/, '') : DEFAULTS.publicBase),
      token: z.string().default(typeof s.token === 'string' ? s.token : DEFAULTS.token), // 配对码即密码；首次启用自动生成
      approvalWaitSec: z.number().default(clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec)),
      sendThrottleSec: z.number().default(clampInt(s.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec)),
      // 手机中继端口：DSH web CLI 封禁 --host 0.0.0.0（宿主安全策略，实测 dsh-web-app
      // startup.js + webserver config schema 双层限制），插件自带路径过滤反向代理，
      // 只把 /mobile-remote/* 暴露到局域网，DSH 本体不出回环。
      relayPort: z.number().default(clampInt(s.relayPort, 0, 65535, DEFAULTS.relayPort)),
    });
  }

  // schema 不可用时的兜底配置（与默认值同形状 + 用户层 seed）。
  const fallbackState = {
    ...DEFAULTS,
    publicBase: typeof seed.publicBase === 'string' ? seed.publicBase.trim().replace(/\/+$/, '') : DEFAULTS.publicBase,
    token: typeof seed.token === 'string' ? seed.token : DEFAULTS.token,
    approvalWaitSec: clampInt(seed.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec),
    sendThrottleSec: clampInt(seed.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec),
    relayPort: clampInt(seed.relayPort, 0, 65535, DEFAULTS.relayPort),
  };

  /** 当前生效配置（命名空间未就绪时回退默认值）。 */
  function st() {
    if (settingsHandle) {
      try { return settingsHandle.get(); } catch {}
    }
    return fallbackState;
  }

  // ── 手机中继：路径过滤反向代理（0.0.0.0:relayPort → 127.0.0.1:webPort）─────
  // 背景：DSH web CLI 显式封禁 --host 0.0.0.0，webserver config schema 也只允许
  // 回环/0.0.0.0——宿主的设计意图是 web 本体不出回环。中继只放行 /mobile-remote/*
  // （token 已在各自路由内校验），比把整个 DSH 座舱暴露到局域网更安全。
  let relayServer = null;
  let relayError = '';

  /** DSH web 上游端口：优先取 webserver 服务的实际监听端口，兜底 3080。 */
  function upstreamPort() {
    try {
      const web = ctx.get('webServer');
      if (web && typeof web.port === 'number' && web.port > 0) return web.port;
    } catch {}
    return 3080;
  }

  function startRelay() {
    const s = st();
    const port = clampInt(s.relayPort, 0, 65535, DEFAULTS.relayPort);
    if (!s.enabled || !port || relayServer) return;
    try {
      relayServer = createRelayServer((req, res) => {
        const path = (req.url || '').split('?')[0];
        const allowed = path.startsWith(ROUTE_PREFIX) && path !== ROUTE_API;
        if (!allowed) {
          // 显式封掉设置接口：中继会把 Host 改写为回环，绕过宿主侧的 loopbackOnly，
          // 而该接口的响应含完整配对链接——绝不能让手机侧可达。
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('mobile-remote relay: path not allowed');
          return;
        }
        // 常规 HTTP 转发（含 SSE 流式响应：pipe 不缓冲，逐块透传）。
        const headers = { ...req.headers, host: '127.0.0.1:' + upstreamPort() };
        const proxy = httpRequest({
          host: '127.0.0.1',
          port: upstreamPort(),
          path: req.url,
          method: req.method,
          headers,
        }, (pRes) => {
          try {
            res.writeHead(pRes.statusCode || 502, pRes.headers);
            pRes.pipe(res);
          } catch {}
        });
        proxy.on('error', () => {
          try {
            res.statusCode = 502;
            res.end('mobile-remote relay: upstream unavailable');
          } catch {}
        });
        req.pipe(proxy);
      });
      relayServer.on('upgrade', () => { /* MVP 不代理 WS 升级 */ });
      relayServer.on('error', (error) => {
        relayError = msgOf(error);
        console.error(PLUGIN_TAG, '中继监听失败 port=' + port + ':', relayError);
        try { relayServer.close(); } catch {}
        relayServer = null;
      });
      relayServer.listen(port, '0.0.0.0', () => {
        relayError = '';
        console.log(PLUGIN_TAG, '手机中继已启动 0.0.0.0:' + port + ' → 127.0.0.1:' + upstreamPort());
      });
    } catch (error) {
      relayError = msgOf(error);
      console.error(PLUGIN_TAG, '中继启动异常:', relayError);
      relayServer = null;
    }
  }

  function stopRelay() {
    if (!relayServer) return;
    try { relayServer.close(); } catch {}
    relayServer = null;
    console.log(PLUGIN_TAG, '手机中继已停止');
  }

  /** 中继自愈：enabled 且未启动则启动（设置热切换后与请求路径上都会调用）。 */
  function ensureRelay() {
    const s = st();
    if (s.enabled && !relayServer && clampInt(s.relayPort, 0, 65535, DEFAULTS.relayPort)) startRelay();
    if (!s.enabled && relayServer) stopRelay();
  }

  // ── 进程内运行状态 ───────────────────────────────────────────────────────
  const pageTemplate = loadPageTemplate();

  let globalSeq = 0;                 // 全站单调事件号：SSE id / 断点补发的游标
  let bootEpoch = randomUUID();      // 每次进程启动唯一；页面据此识别服务器重启并重置游标
  let activeConn = null;             // 当前绑定的唯一手机连接（单连接语义）
  let boundSid = null;               // 当前远程绑定的会话 id
  let boundCwd = '';                 // 绑定会话的工作目录（页面展示用）
  let pinnedSid = null;              // 手机端手动选定的会话（阶段 2 切换语义；null = 跟随电脑当前会话）
  let lastSendAt = 0;                // 上次手机发消息时间（节流）
  const activity = new Map();        // sid → { lastAt, cwd?, status? } 最近活动
  const ring = new Map();            // sid → [{ seq, frame }] 断线补发缓冲
  const pendings = new Map();        // 审批 id → { settle, fallback, toolName, startedAt }
  let disconnectGraceTimer = null;   // 手机断开后的审批回落宽限定时器

  function touchActivity(sid, patch) {
    if (!sid) return;
    const prev = activity.get(sid) || { lastAt: 0, humanAt: 0 };
    const next = { lastAt: Date.now(), humanAt: prev.humanAt || 0, ...patch };
    if (activity.size >= ACTIVITY_CAP && !activity.has(sid)) {
      // 淘汰最旧的一条（Map 保持插入序，第一条即最旧）。
      const oldest = activity.keys().next().value;
      if (oldest !== undefined) activity.delete(oldest);
    }
    activity.set(sid, next);
  }

  function ringFor(sid) {
    let arr = ring.get(sid);
    if (!arr) {
      if (ring.size >= RING_SESSIONS) {
        const oldest = ring.keys().next().value;
        if (oldest !== undefined) ring.delete(oldest);
      }
      arr = [];
      ring.set(sid, arr);
    }
    return arr;
  }

  /**
   * 构造一条 session/event 的 SSE 帧；超长时正文降级为"已截断"占位。
   * 活动连接与环形缓冲共用同一帧：超长正文的文本已由 assistant/chunk
   * 增量送达（小帧、完整入缓冲），最终消息只剩收尾语义，瘦身不影响渲染。
   */
  function buildSessionFrame(sid, type, data) {
    const seq = ++globalSeq;
    const payload = JSON.stringify({ seq, type, data });
    let frame;
    if (payload.length <= FRAME_CAP) {
      frame = `id: ${seq}\nevent: session\ndata: ${payload}\n\n`;
    } else {
      frame = `id: ${seq}\nevent: session\ndata: ${JSON.stringify({ seq, type, clipped: true })}\n\n`;
    }
    const arr = ringFor(sid);
    arr.push({ seq, frame });
    while (arr.length > RING_CAP) arr.shift();
    return { frame, seq };
  }

  /** 向当前活动连接写一帧；连接已死则静默。 */
  function sendFrame(eventName, data, withId) {
    const conn = activeConn;
    if (!conn) return false;
    try {
      const idPart = withId !== undefined ? `id: ${withId}\n` : '';
      conn.res.write(`${idPart}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  // ── token 管理 ───────────────────────────────────────────────────────────
  function generateToken() {
    return randomBytes(16).toString('hex'); // 32 位 hex
  }

  function tokenOk(candidate) {
    const expect = String(st().token || '');
    if (!expect || typeof candidate !== 'string' || candidate.length === 0) return false;
    // 定长哈希后比较，避免长度差直接短路造成的时序泄露。
    const a = createHash('sha256').update(expect).digest();
    const b = createHash('sha256').update(candidate).digest();
    return timingSafeEqual(a, b);
  }

  /** 首次启用时生成配对码并持久化（幂等：已有则跳过）。 */
  async function ensureToken() {
    await ready;
    if (!settingsHandle) return;
    const cur = st();
    if (cur.token) return;
    try {
      const token = generateToken();
      await settingsHandle.update({ token });
      console.log(PLUGIN_TAG, '首次启用：已生成配对码', maskToken(st().token));
    } catch (error) {
      console.error(PLUGIN_TAG, '配对码生成失败:', msgOf(error));
    }
  }

  // ── 会话选择与绑定 ───────────────────────────────────────────────────────
  /** 从 agents 注册表取根 agent 的会话 id 集合（服务缺失时返回 null 表示未知）。 */
  function rootSessionIds() {
    try {
      const agents = ctx.get('agents');
      if (agents && typeof agents.roots === 'function') {
        const ids = new Set();
        for (const a of agents.roots()) {
          const sid = a?.session?.header?.id;
          if (sid) ids.add(String(sid));
        }
        return ids;
      }
    } catch {}
    return null;
  }

  /**
   * 选定"电脑当前会话"：真人最近输入过的根会话优先（humanAt）；
   * 没有真人输入记录时退回会话创建时间（新开的会话优先），
   * 再退回 sessions.list()。任何"最近事件活跃"都不作为依据——
   * 失败重试循环和后台会话的事件流会永远霸占"最近活跃"，实测有此坑。
   */
  function pickSession() {
    try {
      const agents = ctx.get('agents');
      if (agents && typeof agents.roots === 'function') {
        let best = null;
        for (const a of agents.roots()) {
          const sid = a?.session?.header?.id;
          if (!sid) continue;
          const info = activity.get(String(sid)) || {};
          const created = Date.parse(a?.session?.header?.createdAt || '') || 0;
          const score = info.humanAt || created; // 真人输入 > 最近创建
          if (!best || score > best.score) {
            best = { sid: String(sid), score, cwd: a?.session?.header?.cwd || '' };
          }
        }
        if (best) return best;
      }
    } catch {}
    try {
      const store = ctx.get('sessions');
      if (store && typeof store.list === 'function') {
        let best = null;
        for (const s of store.list()) {
          const sid = s?.header?.id;
          if (!sid) continue;
          const info = activity.get(String(sid)) || {};
          const created = Date.parse(s?.header?.createdAt || '') || 0;
          const score = info.humanAt || created;
          if (!best || score > best.score) {
            best = { sid: String(sid), score, cwd: s?.header?.cwd || '' };
          }
        }
        if (best) return { sid: best.sid, cwd: best.cwd };
      }
    } catch {}
    return null;
  }

  function bindSession(sel) {
    boundSid = sel ? sel.sid : null;
    boundCwd = sel ? (sel.cwd || '') : '';
    if (boundSid) console.log(PLUGIN_TAG, '绑定会话', boundSid);
  }

  /** 电脑端"停止远程"：断开所有手机连接，挂起审批立即回落。 */
  function stopRemote(reason) {
    for (const p of pendings.values()) {
      try { p.settle(p.fallback(), 'stop'); } catch {}
    }
    pendings.clear();
    clearGraceTimer();
    boundSid = null;
    boundCwd = '';
    pinnedSid = null; // 钉住语义随"停止远程"一起清除，下次连接回到自动挑选
    if (activeConn) {
      try {
        activeConn.res.write(`event: stopped\ndata: {}\n\n`);
        activeConn.res.end();
      } catch {}
      teardownConn(activeConn);
      activeConn = null;
    }
    console.log(PLUGIN_TAG, '停止远程：', reason);
  }

  function clearGraceTimer() {
    if (disconnectGraceTimer) {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = null;
    }
  }

  /** 手机连接断开后的收尾：挂起审批在宽限期后回落电脑端（期间重连则取消）。 */
  function scheduleApprovalFallback() {
    clearGraceTimer();
    if (pendings.size === 0) return;
    disconnectGraceTimer = setTimeout(() => {
      disconnectGraceTimer = null;
      if (activeConn || pendings.size === 0) return;
      console.log(PLUGIN_TAG, '手机断开超过宽限期，挂起审批回落电脑端');
      for (const p of pendings.values()) {
        try { p.settle(p.fallback(), 'disconnect'); } catch {}
      }
      pendings.clear();
    }, DISCONNECT_GRACE_MS);
  }

  function teardownConn(conn) {
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    try { conn.res.end(); } catch {}
  }

  // ── 事件接线：session/event / agent/status ───────────────────────────────
  ctx.on('session/event', (subject, event) => {
    try {
      const sid = String(subject?.header?.id || subject?.id || '');
      if (!sid) return;
      const type = String(event?.type || '');
      // "真人输入"标记：只有电脑端用户敲下的 user/message 才算（source.kind === 'user'）。
      // 插件 steer（kind:'plugin'）、失败重试轮、后台事件都不能代表"用户正在这个会话"。
      const isHumanInput = type === 'user/message' && event?.data?.source?.kind === 'user';
      touchActivity(sid, isHumanInput ? { humanAt: Date.now(), errorMsg: '' } : undefined);
      // 回合边界记录：turn/end 的 reason.kind 供"完成"状态映射使用（turn/start 时清零）。
      if (type === 'turn/end') touchActivity(sid, { turnReason: String(event?.data?.reason?.kind || '') });
      else if (type === 'turn/start') touchActivity(sid, { turnReason: '' });
      if (!st().enabled) return; // 停用即零参与：不建帧、不转发、不占缓冲
      // 未绑定 + 有手机连接：首个根会话事件自动补绑（手机先开、电脑后干活的场景）。
      if (!boundSid && activeConn) {
        const roots = rootSessionIds();
        if (roots === null || roots.has(sid)) {
          bindSession({ sid, cwd: '' });
          sendFrame('bound', { sessionId: boundSid, cwd: boundCwd });
        }
      }
      // 阶段 2 转发策略：绑定会话直发 + 全部根会话入环形缓冲。
      // 阶段 1 只在绑定会话上转发，会让"切换会话"看到空白流——现在 enabled 期间
      // 所有根会话的事件都建帧入各自缓冲（有界：16 会话 × 200 帧），切换/重连时
      // 按连接级游标补发；子代理等非根会话不入缓冲。
      const isBound = sid === boundSid;
      if (!isBound) {
        const roots = rootSessionIds();
        if (roots === null || !roots.has(sid)) return;
      }
      const { frame, seq } = buildSessionFrame(sid, type, event?.data ?? {});
      if (activeConn && isBound) {
        try { activeConn.res.write(frame); } catch {} // 直发完整帧
        activeConn.cursorBySid.set(sid, seq);         // 连接级会话游标：切换补发去重
      }
      // 审计事件顺带驱动挂起审批的对账（防御：正常路径由手机 POST 先行 settle）。
      if (type === 'approval/decided' && event?.data?.id && pendings.has(String(event.data.id))) {
        const p = pendings.get(String(event.data.id));
        pendings.delete(String(event.data.id));
        try { p.settle(event.data.outcome, 'external'); } catch {}
      }
      if (type === 'approval/asked') {
        console.log(PLUGIN_TAG, '审批请求入流 tool=' + clip(event?.data?.toolName, 40));
      }
    } catch (error) {
      console.error(PLUGIN_TAG, 'session/event 处理异常:', msgOf(error));
    }
  });

  ctx.on('agent/status', (payload) => {
    try {
      const raw = String(payload?.status || '');
      const agent = payload?.agent;
      const sid = extractSessionId(payload);
      const cwd = agent?.session?.header?.cwd;
      // 四态映射（启发式，CHANGELOG 如实说明）：running → 运行中；idle 且上一回合
      // 正常收尾（turn/end reason.kind==='completed'）→ 完成；其余 idle → 空闲；
      // agent/error → 错误（见下），真人新输入或新一轮运行时清除。
      let eff = raw;
      if (raw === 'idle') {
        const prev = sid ? activity.get(String(sid)) : undefined;
        eff = prev?.turnReason === 'completed' ? 'done' : 'idle';
      }
      touchActivity(sid, {
        status: eff,
        ...(cwd ? { cwd } : {}),
        ...(raw === 'running' ? { errorMsg: '' } : {}), // 新一轮运行：清除错误标记
      });
      if (!st().enabled || !activeConn) return;
      if (!boundSid && sid) {
        const roots = rootSessionIds();
        if (roots === null || roots.has(String(sid))) {
          bindSession({ sid: String(sid), cwd });
          sendFrame('bound', { sessionId: boundSid, cwd: boundCwd });
        }
      }
      if (sid && String(sid) === boundSid) {
        sendFrame('status', { sessionId: String(sid), status: eff });
      }
    } catch (error) {
      console.error(PLUGIN_TAG, 'agent/status 处理异常:', msgOf(error));
    }
  });

  // agent/error：把会话标记为错误态（宿主侧有 30s 跨会话去抖经验），顶栏/列表显示
  // 「错误」chip。事件载荷宿主未给文档，会话 id 与错误文本均防御式提取。
  ctx.on('agent/error', (payload) => {
    try {
      const sid = extractSessionId(payload);
      const rawMsg = payload?.error?.message ?? payload?.message
        ?? (typeof payload?.error === 'string' ? payload.error : '');
      const message = clip(rawMsg, 200);
      touchActivity(sid, { status: 'error', errorMsg: message });
      if (!st().enabled || !activeConn) return;
      if (sid && String(sid) === boundSid) {
        sendFrame('status', { sessionId: String(sid), status: 'error', error: message });
      }
    } catch (error) {
      console.error(PLUGIN_TAG, 'agent/error 处理异常:', msgOf(error));
    }
  });

  // ── 手机审批：拦截 approval/request（混合回落，P3 语义）───────────────────
  ctx.on('approval/request', async (req, next) => {
    try {
      const s = st();
      if (!s.enabled || !activeConn) return next();
      const sid = req?.agent?.session?.header?.id ? String(req.agent.session.header.id) : undefined;
      if (!sid || sid !== boundSid) return next(); // 只拦截绑定会话的审批，其余交回电脑端
      if (pendings.size >= PENDING_CAP) {
        console.log(PLUGIN_TAG, '挂起审批过多，交回电脑端');
        return next();
      }
      const id = randomUUID();
      const toolName = clip(req?.toolName ?? '未知工具', 80);
      const reason = clip(req?.reason ?? '', 800);
      const waitSec = clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec);
      sendFrame('approval', { id, toolName, reason, waitSec });
      console.log(PLUGIN_TAG, `审批已推手机 id=${id.slice(0, 8)} tool=${clip(toolName, 40)} wait=${waitSec}s`);
      return await new Promise((resolve) => {
        let settled = false;
        const settle = (outcome, via) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          pendings.delete(id);
          console.log(PLUGIN_TAG, `审批决定 id=${id.slice(0, 8)} via=${via}`);
          sendFrame('approval_result', { id, decision: String(outcome), via });
          resolve(outcome);
        };
        const timer = setTimeout(() => settle(next(), 'timeout'), waitSec * 1000); // 超时 → 电脑端 GUI
        const signal = req?.signal;
        const onAbort = () => settle('cancelled', 'abort'); // 调用方中止：词汇表内的终局值
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        pendings.set(id, {
          toolName,
          reason, // 整页重载后重推审批条时需要
          startedAt: Date.now(),
          fallback: () => next(), // 停止远程 / 断线回落时调用
          settle,
        });
      });
    } catch (error) {
      console.error(PLUGIN_TAG, 'approval 处理异常，交回电脑端:', msgOf(error));
      return next();
    }
  });

  // 插件卸载：断开手机、挂起审批回落、停掉中继，避免留下悬挂资源。
  ctx.effect(() => () => {
    try { stopRelay(); } catch {}
    try { stopRemote('插件卸载'); } catch {}
  }, 'mobile-remote: teardown');

  // ── HTTP 帮助函数 ────────────────────────────────────────────────────────
  function sendJson(res, status, value) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(value));
  }

  function sendHtml(res, status, html) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  }

  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolvePromise, rejectPromise) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > limit) {
          rejectPromise(new RangeError('request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          resolvePromise(body.length > 0 ? JSON.parse(body) : {});
        } catch (error) {
          rejectPromise(error);
        }
      });
      req.on('error', rejectPromise);
    });
  }

  const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

  /**
   * 设置接口仅限电脑回环：Host 必须是回环地址（浏览器无法伪造 Host，
   * 防 DNS rebinding 与局域网内浏览器跨站读取）；带 Origin 时额外要求同源。
   */
  function loopbackOnly(req) {
    const host = String(req.headers.host || '');
    if (!LOOPBACK_HOST_RE.test(host)) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /** 从请求 Host 头取端口（保留给调试 URL 拼装场景）。 */
  function portOf(hostHeader) {
    const m = String(hostHeader || '').match(/:(\d+)$/);
    return m ? m[1] : '80';
  }

  /** 设置接口的状态视图（GET / POST 响应共用）。 */
  function stateView(req) {
    const s = st();
    const token = String(s.token || '');
    const hostHeader = String(req.headers.host || '127.0.0.1:3080');
    const local = token ? `http://${hostHeader}${ROUTE_PREFIX}p/${token}` : '';
    const { lan, tailscale } = pickLanAddrs();
    const relayPort = clampInt(s.relayPort, 0, 65535, DEFAULTS.relayPort);
    let phone = '';
    let phoneSource = '';
    if (token) {
      if (s.publicBase) {
        phone = `${s.publicBase}${ROUTE_PREFIX}p/${token}`;
        phoneSource = 'publicBase';
      } else if (lan.length > 0 && relayPort) {
        // 手机地址走中继端口（DSH web 本体只绑回环，手机不可直达 3080）。
        phone = `http://${lan[0]}:${relayPort}${ROUTE_PREFIX}p/${token}`;
        phoneSource = 'relay';
      } else {
        phone = local; // 没有任何可用对外地址：退回本机调试地址并提示
        phoneSource = 'loopback';
      }
    }
    return {
      ok: true,
      enabled: !!s.enabled,
      publicBase: typeof s.publicBase === 'string' ? s.publicBase : '',
      hasToken: Boolean(token),
      tokenMasked: maskToken(token),
      approvalWaitSec: clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec),
      sendThrottleSec: clampInt(s.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec),
      relayPort,
      relayRunning: Boolean(relayServer),
      relayError,
      active: activeConn ? 1 : 0,
      boundSession: boundSid,
      boundStatus: boundSid ? (activity.get(boundSid)?.status || null) : null,
      pinnedSession: pinnedSid,
      urls: { local, phone, phoneSource },
      lan,
      tailscale,
    };
  }

  // ── 会话列表视图（阶段 2）：全量逻辑会话 + 标题 + 运行态合并 ────────────────
  const titleCache = new Map(); // sid → { title, at }：标题折叠要回放会话日志，缓存 60s 控制开销
  async function listSessionsView() {
    const out = [];
    // 1) 全量逻辑会话（live 优先、newest-first、带持久化标志；P4 实测形状）。
    try {
      const q = ctx.get('sessionQuery');
      if (q && typeof q.listSessions === 'function') {
        const all = await q.listSessions();
        for (const rec of Array.isArray(all) ? all : []) {
          const h = rec?.header || {};
          const sid = h.id !== undefined && h.id !== null ? String(h.id) : '';
          if (!sid) continue;
          out.push({
            id: sid,
            createdAt: typeof h.createdAt === 'number' ? h.createdAt : (Date.parse(h.createdAt) || 0),
            cwd: typeof h.cwd === 'string' ? h.cwd : '',
            live: rec.live === true,
            persisted: rec.persisted === true,
          });
        }
      }
    } catch {}
    // 2) sessionQuery 不可用时退回 live 会话枚举。
    if (out.length === 0) {
      try {
        const store = ctx.get('sessions');
        if (store && typeof store.list === 'function') {
          for (const s of store.list()) {
            const sid = String(s?.header?.id || s?.id || '');
            if (!sid) continue;
            out.push({
              id: sid,
              createdAt: typeof s?.header?.createdAt === 'number' ? s.header.createdAt : (Date.parse(s?.header?.createdAt) || 0),
              cwd: typeof s?.header?.cwd === 'string' ? s.header.cwd : '',
              live: true,
              persisted: false,
            });
          }
        }
      } catch {}
    }
    // 3) 标题：readTitleSnapshots 按会话回放日志折叠 session/title（结果逐会话
    //    fulfilled/rejected 隔离），批量上限 50 + 60s 缓存，避免频繁开抽屉都全量回放。
    const now = Date.now();
    const missing = [];
    for (const it of out) {
      const c = titleCache.get(it.id);
      if (c && now - c.at < 60 * 1000) it.title = c.title;
      else missing.push(it.id);
    }
    if (missing.length > 0) {
      try {
        const q = ctx.get('sessionQuery');
        if (q && typeof q.readTitleSnapshots === 'function') {
          const snaps = await q.readTitleSnapshots(missing.slice(0, 50));
          if (Array.isArray(snaps)) {
            for (let i = 0; i < snaps.length; i++) {
              const snap = snaps[i];
              // projectMany 结果形状：{sessionId, status:'fulfilled'|'rejected', value?}；
              // 兼容直接返回值的形态，防御宿主版本差异。
              const value = snap && snap.status === 'fulfilled' ? snap.value : (snap && !snap.status ? snap : null);
              const title = value && value.title && typeof value.title.title === 'string' ? value.title.title : '';
              titleCache.set(missing[i], { title, at: now });
            }
          }
        }
      } catch {}
      for (const it of out) {
        if (it.title === undefined) {
          const c = titleCache.get(it.id);
          it.title = (c && c.title) || '';
        }
      }
    }
    // 4) 合并运行态（activity）与绑定标记；上限 100 条（手机抽屉用不了更多）。
    for (const it of out) {
      const a = activity.get(it.id);
      it.status = a?.status || (it.live ? 'idle' : 'ended');
      it.humanAt = a?.humanAt || 0;
      it.bound = it.id === boundSid;
    }
    if (out.length > 100) out.length = 100;
    return out;
  }

  // ── 路由注册（P1 实测形态：exact 先于 prefix 匹配）────────────────────────
  ctx.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposals = [];
      const reg = (route) => disposals.push(webCtx.webServer.register(route));

      // 1) 设置页数据接口：仅电脑回环可用。
      reg({
        kind: 'exact',
        path: ROUTE_API,
        handler: async (req, res) => {
          if (!loopbackOnly(req)) {
            sendJson(res, 403, { ok: false, code: 'origin-rejected', message: '设置接口仅限本机访问' });
            return;
          }
          if (req.method === 'GET') {
            sendJson(res, 200, stateView(req));
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'Use GET or POST' });
            return;
          }
          let parsed;
          try {
            parsed = await readJson(req, 8 * 1024);
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'invalid-request', message: msgOf(error) });
            return;
          }
          await ready;
          if (!settingsHandle) {
            sendJson(res, 503, { ok: false, code: 'settings-unavailable', message: 'settings namespace not ready' });
            return;
          }
          // 收敛为合法补丁（settings.update 是递归深合并，单键补丁不影响其它键）。
          const patch = {};
          let stopRequested = false;
          if (typeof parsed.enabled === 'boolean') patch.enabled = parsed.enabled;
          if (parsed.resetToken === true) {
            patch.token = generateToken();
            stopRequested = true; // 旧配对链接立即失效
          }
          if (parsed.stop === true) stopRequested = true;
          if (typeof parsed.publicBase === 'string') {
            const pb = parsed.publicBase.trim().replace(/\/+$/, '');
            if (pb.length <= 200) patch.publicBase = pb;
          }
          if (Number.isSafeInteger(parsed.approvalWaitSec) && parsed.approvalWaitSec >= 15 && parsed.approvalWaitSec <= 600) {
            patch.approvalWaitSec = parsed.approvalWaitSec;
          }
          if (Number.isSafeInteger(parsed.sendThrottleSec) && parsed.sendThrottleSec >= 1 && parsed.sendThrottleSec <= 60) {
            patch.sendThrottleSec = parsed.sendThrottleSec;
          }
          if (Number.isSafeInteger(parsed.relayPort) && parsed.relayPort >= 0 && parsed.relayPort <= 65535) {
            patch.relayPort = parsed.relayPort;
          }
          try {
            if (Object.keys(patch).length > 0) await settingsHandle.update(patch);
          } catch (error) {
            sendJson(res, 409, { ok: false, code: 'settings-rejected', message: msgOf(error) });
            return;
          }
          if (patch.enabled === true) await ensureToken();
          ensureRelay(); // 中继跟随 enabled 热启停；端口变更同样在此生效
          if (stopRequested) stopRemote(parsed.resetToken ? '配对码重置' : '电脑端请求停止');
          console.log(PLUGIN_TAG, '设置已更新: enabled=' + st().enabled
            + ' publicBase=' + (st().publicBase ? '已配置' : '未配置')
            + ' waitSec=' + st().approvalWaitSec);
          sendJson(res, 200, stateView(req));
        },
      });

      // 2) 手机 SSE 长连接：?token=<配对码>&since=<上次事件号>。
      reg({
        kind: 'exact',
        path: ROUTE_SSE,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://x');
          if (!st().enabled) {
            sendJson(res, 404, { ok: false, code: 'disabled', message: '远程控制未开启' });
            return;
          }
          ensureRelay(); // 中继自愈（进程内异常重启后第一条请求即恢复）
          if (!tokenOk(url.searchParams.get('token') || '')) {
            console.log(PLUGIN_TAG, 'SSE 鉴权失败（配对码不匹配）');
            sendJson(res, 401, { ok: false, code: 'bad-token', message: '配对码无效' });
            return;
          }
          const sinceRaw = url.searchParams.get('since');
          const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;

          // 单连接绑定：顶替旧连接并明确通知（旧页面据此停止自动重连）。
          if (activeConn) {
            const old = activeConn;
            try {
              old.res.write(`event: replaced\ndata: {}\n\n`);
            } catch {}
            teardownConn(old);
            console.log(PLUGIN_TAG, '旧手机连接已被顶替 #' + old.id);
          }

          // 选定并绑定会话：手机端钉住过则回到钉住的会话（切换语义跨重连保持）；
          // 否则自动挑选"电脑当前会话"（真人输入优先，决策 10）。
          if (pinnedSid) {
            bindSession({ sid: pinnedSid, cwd: activity.get(pinnedSid)?.cwd || '' });
          } else {
            bindSession(pickSession());
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(': connected\n\n'); // 立即冲刷头部，确认链路
          const conn = { id: randomUUID().slice(0, 8), res, heartbeat: null, cursorBySid: new Map() };
          activeConn = conn;
          clearGraceTimer();

          // 断点补发：只补当前绑定会话、seq 大于游标的帧（P5：整页重载是主恢复路径）。
          // 首次进入（无游标）也回放缓冲里的近期帧，手机一进来就能看到最近对话；
          // 补发后记下该会话的连接级游标，切走再切回时只补没看过的帧。
          if (boundSid) {
            const cursor = since !== null ? since : 0;
            let maxSeq = cursor;
            for (const item of ringFor(boundSid)) {
              if (item.seq > cursor) {
                try { res.write(item.frame); } catch {}
                if (item.seq > maxSeq) maxSeq = item.seq;
              }
            }
            conn.cursorBySid.set(boundSid, maxSeq);
          }
          const s = st();
          sendFrame('hello', {
            sessionId: boundSid,
            cwd: boundCwd,
            status: boundSid ? (activity.get(boundSid)?.status || 'idle') : null,
            waitSec: clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec),
            throttleSec: clampInt(s.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec),
            seq: globalSeq,       // 当前游标：页面无增量时也以此推进 since
            epoch: bootEpoch,     // 服务器重启后页面据此重置游标
          });
          // 重建期间尚有挂起审批：重新推送审批条（P5 整页重载场景）。
          for (const [pid, p] of pendings) {
            sendFrame('approval', {
              id: pid,
              toolName: p.toolName,
              reason: p.reason ?? '',
              waitSec: clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec),
              startedAt: p.startedAt,
            });
          }
          console.log(PLUGIN_TAG, `SSE 建连 #${conn.id} since=${since ?? '-'} 绑定=${boundSid ?? '无'}`);

          conn.heartbeat = setInterval(() => {
            try { res.write(': hb\n\n'); } catch {}
          }, HEARTBEAT_MS);

          req.on('close', () => {
            if (activeConn === conn) {
              activeConn = null;
              console.log(PLUGIN_TAG, `SSE 断开 #${conn.id}`);
              scheduleApprovalFallback();
            }
            teardownConn(conn);
          });
        },
      });

      // 3) 手机发消息 → agent.steer（来源标记 plugin:'mobile-remote'，P2 无频控；节流仅防连点）。
      reg({
        kind: 'exact',
        path: ROUTE_SEND,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' });
            return;
          }
          if (!st().enabled) {
            sendJson(res, 404, { ok: false, code: 'disabled', message: '远程控制未开启' });
            return;
          }
          let parsed;
          try {
            parsed = await readJson(req);
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'invalid-request', message: msgOf(error) });
            return;
          }
          if (!tokenOk(String(parsed.token || ''))) {
            sendJson(res, 401, { ok: false, code: 'bad-token', message: '配对码无效' });
            return;
          }
          if (!boundSid) {
            sendJson(res, 409, { ok: false, code: 'no-session', message: '尚未绑定会话，先在电脑端开始一个会话' });
            return;
          }
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text || text.length > 8000) {
            sendJson(res, 400, { ok: false, code: 'bad-text', message: '消息为空或超过 8000 字' });
            return;
          }
          const throttleSec = clampInt(st().sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec);
          const gapMs = throttleSec * 1000;
          const waitMs = lastSendAt + gapMs - Date.now();
          if (waitMs > 0) {
            sendJson(res, 429, { ok: false, code: 'throttled', message: '发送太快，稍候再试', retryAfterMs: waitMs });
            return;
          }
          let agent;
          try {
            const agents = ctx.get('agents');
            agent = agents && typeof agents.get === 'function' ? agents.get(boundSid) : undefined;
          } catch {}
          if (!agent || typeof agent.steer !== 'function') {
            sendJson(res, 409, { ok: false, code: 'agent-unavailable', message: '会话代理未就绪（会话可能已结束），刷新页面重新绑定' });
            return;
          }
          try {
            const llm = await loadLlm();
            agent.steer(llm.createUserMessage({
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: 'mobile-remote' }, // 来源标记（roadmap 决策 6）
            }));
          } catch (error) {
            console.error(PLUGIN_TAG, 'steer 失败:', msgOf(error));
            sendJson(res, 500, { ok: false, code: 'steer-failed', message: msgOf(error) });
            return;
          }
          lastSendAt = Date.now();
          console.log(PLUGIN_TAG, '手机消息已 steer 到', boundSid, '长度=' + text.length);
          sendJson(res, 200, { ok: true, sessionId: boundSid });
        },
      });

      // 4) 手机审批应答（spec 的 approve/:id 落成 body 传 id——宿主 exact 路由不带参数）。
      reg({
        kind: 'exact',
        path: ROUTE_APPROVE,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' });
            return;
          }
          if (!st().enabled) {
            sendJson(res, 404, { ok: false, code: 'disabled', message: '远程控制未开启' });
            return;
          }
          let parsed;
          try {
            parsed = await readJson(req, 4 * 1024);
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'invalid-request', message: msgOf(error) });
            return;
          }
          if (!tokenOk(String(parsed.token || ''))) {
            sendJson(res, 401, { ok: false, code: 'bad-token', message: '配对码无效' });
            return;
          }
          const id = String(parsed.id || '');
          const p = pendings.get(id);
          if (!p) {
            sendJson(res, 404, { ok: false, code: 'unknown-approval', message: '审批不存在或已处理' });
            return;
          }
          const decision = parsed.decision === 'allow' ? 'allowed-once' : 'rejected';
          p.settle(decision, 'phone');
          sendJson(res, 200, { ok: true, id, decision });
        },
      });

      // 5) 会话列表（阶段 2）：手机端抽屉数据源。
      reg({
        kind: 'exact',
        path: ROUTE_SESSIONS,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' });
            return;
          }
          if (!st().enabled) {
            sendJson(res, 404, { ok: false, code: 'disabled', message: '远程控制未开启' });
            return;
          }
          ensureRelay(); // 中继自愈
          const url = new URL(req.url, 'http://x');
          if (!tokenOk(url.searchParams.get('token') || '')) {
            sendJson(res, 401, { ok: false, code: 'bad-token', message: '配对码无效' });
            return;
          }
          const sessions = await listSessionsView();
          sendJson(res, 200, { ok: true, sessions, boundSession: boundSid, pinnedSession: pinnedSid });
        },
      });

      // 6) 切换绑定会话（阶段 2）：sessionId 为空 = 回到"跟随电脑当前会话"。
      //    切换只改本进程绑定与手机端流；挂起审批不属于任何会话视图，保持全局可答。
      reg({
        kind: 'exact',
        path: ROUTE_SWITCH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST only' });
            return;
          }
          if (!st().enabled) {
            sendJson(res, 404, { ok: false, code: 'disabled', message: '远程控制未开启' });
            return;
          }
          let parsed;
          try {
            parsed = await readJson(req, 4 * 1024);
          } catch (error) {
            sendJson(res, 400, { ok: false, code: 'invalid-request', message: msgOf(error) });
            return;
          }
          if (!tokenOk(String(parsed.token || ''))) {
            sendJson(res, 401, { ok: false, code: 'bad-token', message: '配对码无效' });
            return;
          }
          const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
          let live = true;
          if (!sid) {
            pinnedSid = null; // 清除钉住，回到自动挑选
            const target = pickSession();
            if (!target) {
              sendJson(res, 409, { ok: false, code: 'no-session', message: '电脑端暂无可绑定的会话' });
              return;
            }
            bindSession(target);
          } else {
            // 校验目标会话存在（sessions.list 查 live，sessionQuery 查全量含持久化）。
            let found = false;
            let cwd = activity.get(sid)?.cwd || '';
            try {
              const store = ctx.get('sessions');
              if (store && typeof store.list === 'function') {
                for (const s of store.list()) {
                  if (String(s?.header?.id || s?.id || '') === sid) {
                    found = true; live = true; cwd = s?.header?.cwd || cwd;
                    break;
                  }
                }
              }
            } catch {}
            if (!found) {
              try {
                const q = ctx.get('sessionQuery');
                if (q && typeof q.listSessions === 'function') {
                  const all = await q.listSessions();
                  for (const rec of Array.isArray(all) ? all : []) {
                    if (String(rec?.header?.id) === sid) {
                      found = true; live = rec?.live === true; cwd = rec?.header?.cwd || cwd;
                      break;
                    }
                  }
                }
              } catch {}
            }
            if (!found) {
              sendJson(res, 404, { ok: false, code: 'session-not-found', message: '会话不存在或已清理' });
              return;
            }
            pinnedSid = sid;
            bindSession({ sid, cwd });
          }
          // 通知页面（switched=true 时页面清空消息流），随后按连接级游标补发目标会话近期帧。
          sendFrame('bound', { sessionId: boundSid, cwd: boundCwd, switched: true, live });
          const conn = activeConn;
          if (conn && boundSid) {
            const cursor = conn.cursorBySid.get(boundSid) || 0;
            let maxSeq = cursor;
            for (const item of ringFor(boundSid)) {
              if (item.seq > cursor) {
                try { conn.res.write(item.frame); } catch {}
                if (item.seq > maxSeq) maxSeq = item.seq;
              }
            }
            conn.cursorBySid.set(boundSid, maxSeq);
          }
          console.log(PLUGIN_TAG, '切换绑定会话 →', (boundSid || '无') + (sid ? '' : '（跟随电脑）'));
          sendJson(res, 200, { ok: true, sessionId: boundSid, cwd: boundCwd, live });
        },
      });

      // 7) 移动端单页：/mobile-remote/p/<token>，token 即路径段，错码 401。
      // 注意宿主 prefix 匹配是 pathname.startsWith(path + '/')（P1 实测），
      // 注册路径不能带尾斜杠，否则变成 /mobile-remote// 永不匹配。
      reg({
        kind: 'prefix',
        path: '/mobile-remote',
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://x');
          const pathname = url.pathname;
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' });
            return;
          }
          // 日志不落 token：路径里的配对码一律打码。
          const logPath = pathname.startsWith(ROUTE_PREFIX + 'p/') ? ROUTE_PREFIX + 'p/***' : pathname;
          if (!st().enabled) {
            sendHtml(res, 503, errorPage('远程未开启', '请在电脑端 DSH 设置页打开「移动端远程控制」开关。'));
            return;
          }
          ensureRelay(); // 中继自愈
          const m = pathname.match(/^\/mobile-remote\/p\/([A-Za-z0-9_-]+)\/?$/);
          if (!m) {
            sendHtml(res, 404, errorPage('缺少配对码', '请通过电脑端设置页的二维码或链接打开本页。'));
            return;
          }
          if (!tokenOk(m[1])) {
            console.log(PLUGIN_TAG, '页面鉴权失败 path=' + logPath);
            sendHtml(res, 401, errorPage('配对码无效', '链接已失效或配对码已重置。请在电脑端设置页重新复制链接。'));
            return;
          }
          console.log(PLUGIN_TAG, '页面已下发 path=' + logPath);
          sendHtml(res, 200, pageTemplate);
        },
      });

      console.log(PLUGIN_TAG, 'webServer 路由已注册（/mobile-remote/）');
      // effect 清理：插件停用即注销全部路由。
      return () => {
        for (const dispose of disposals) {
          try { dispose(); } catch {}
        }
        try { stopRemote('路由注销'); } catch {}
      };
    }, 'mobile-remote: routes');
  });

  // ── 诊断工具：审批链路自测（镜像 phone-push「发送测试消息」的自检思路）──────
  // 设置页无法直接发起审批（approval.request 需要处于开启回合的 agent，见 P3），
  // 因此由模型经工具调用走真实审批服务。仅在用户要求自测时使用。
  ctx.tools.register({
    name: 'mobile_remote_selftest',
    description: 'mobile-remote 诊断工具：发起一次真实的审批请求，用于验证「手机审批/电脑端回落」链路。仅当用户要求测试移动端远程控制或审批链路时调用一次；不要在其他场景主动调用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          outcome: { type: 'string' },
        },
        required: ['ok', 'outcome'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: '审批自测结果: ' + String(value?.outcome) + (value?.ok ? '（已放行）' : ''),
      }],
    },
    async execute(_args, exec) {
      const approval = ctx.get('approval');
      if (!approval || typeof approval.request !== 'function') {
        return { ok: false, outcome: 'approval-service-missing' };
      }
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: 'mobile_remote_selftest',
        reason: 'mobile-remote 审批链路自测（可在手机端允许/拒绝，或等超时回落电脑端）',
      });
      return { ok: outcome === 'allowed-once', outcome: String(outcome) };
    },
  });

  // 启动日志：token 打码；publicBase 是否配置只报有无，不回显全文。
  void ready.then(() => {
    ensureToken(); // 已配置过 token 则幂等跳过
    ensureRelay(); // 开机已是启用态则直接拉起中继
    const s = st();
    console.log(PLUGIN_TAG, `ready; enabled=${s.enabled} token=${maskToken(s.token)}`
      + ` publicBase=${s.publicBase ? '已配置' : '未配置'} waitSec=${s.approvalWaitSec} relayPort=${s.relayPort}`);
  });
}
