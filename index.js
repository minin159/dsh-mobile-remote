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

export const name = 'mobile-remote';

/** 本插件不注册模型常驻工具以外的服务依赖；工具注册表用于自测工具。 */
export const inject = ['tools'];

const ROUTE_API = '/mobile-remote/api';
const ROUTE_SSE = '/mobile-remote/sse';
const ROUTE_SEND = '/mobile-remote/send';
const ROUTE_APPROVE = '/mobile-remote/approve';
const ROUTE_PREFIX = '/mobile-remote/';

const PLUGIN_TAG = '[mobile-remote]';

/** 设置默认值（settings 命名空间未就绪时的兜底，与 schema 默认一致）。 */
const DEFAULTS = {
  enabled: false,
  publicBase: '',
  token: '',
  approvalWaitSec: 120, // 手机审批等待窗口；超时 next() 回落电脑端 GUI
  sendThrottleSec: 2,   // 发送节流（防连点，UI 同步用）
};

/** 环形缓冲上限：每会话缓存最近 200 条转发帧，供断线/整页重载后补发。 */
const RING_CAP = 200;
/** 环形缓冲最多追踪的会话数（超出淘汰最旧的）。 */
const RING_SESSIONS = 8;
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
            const z = (await import('@deepseek-ai/schemastery')).default ??
              (await import('@deepseek-ai/schemastery'));
            settingsHandle = scope.settings.register('mobile-remote', buildSchema(z, seed), { applies: 'live' });
            console.log(PLUGIN_TAG, 'settings namespace registered');
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
      // 手机侧可达的对外地址（如 http://192.168.10.10:3080 或 Tailscale 地址）；
      // 空 = 设置页用自动探测的局域网地址拼配对链接。
      publicBase: z.string().default(typeof s.publicBase === 'string' ? s.publicBase.trim().replace(/\/+$/, '') : DEFAULTS.publicBase),
      token: z.string().default(typeof s.token === 'string' ? s.token : DEFAULTS.token), // 配对码即密码；首次启用自动生成
      approvalWaitSec: z.number().default(clampInt(s.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec)),
      sendThrottleSec: z.number().default(clampInt(s.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec)),
    });
  }

  // schema 不可用时的兜底配置（与默认值同形状 + 用户层 seed）。
  const fallbackState = {
    ...DEFAULTS,
    publicBase: typeof seed.publicBase === 'string' ? seed.publicBase.trim().replace(/\/+$/, '') : DEFAULTS.publicBase,
    token: typeof seed.token === 'string' ? seed.token : DEFAULTS.token,
    approvalWaitSec: clampInt(seed.approvalWaitSec, 15, 600, DEFAULTS.approvalWaitSec),
    sendThrottleSec: clampInt(seed.sendThrottleSec, 1, 60, DEFAULTS.sendThrottleSec),
  };

  /** 当前生效配置（命名空间未就绪时回退默认值）。 */
  function st() {
    if (settingsHandle) {
      try { return settingsHandle.get(); } catch {}
    }
    return fallbackState;
  }

  // ── 进程内运行状态 ───────────────────────────────────────────────────────
  const pageTemplate = loadPageTemplate();

  let globalSeq = 0;                 // 全站单调事件号：SSE id / 断点补发的游标
  let bootEpoch = randomUUID();      // 每次进程启动唯一；页面据此识别服务器重启并重置游标
  let activeConn = null;             // 当前绑定的唯一手机连接（单连接语义）
  let boundSid = null;               // 当前远程绑定的会话 id
  let boundCwd = '';                 // 绑定会话的工作目录（页面展示用）
  let lastSendAt = 0;                // 上次手机发消息时间（节流）
  const activity = new Map();        // sid → { lastAt, cwd?, status? } 最近活动
  const ring = new Map();            // sid → [{ seq, frame }] 断线补发缓冲
  const pendings = new Map();        // 审批 id → { settle, fallback, toolName, startedAt }
  let disconnectGraceTimer = null;   // 手机断开后的审批回落宽限定时器

  function touchActivity(sid, patch) {
    if (!sid) return;
    const prev = activity.get(sid) || { lastAt: 0 };
    const next = { ...prev, ...patch, lastAt: Date.now() };
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
   * 选定"电脑当前会话"：根 agent 里最近活跃者优先；
   * agents 服务不可用时退回 sessions.list()（live 会话）再退回活动表。
   */
  function pickSession() {
    try {
      const agents = ctx.get('agents');
      if (agents && typeof agents.roots === 'function') {
        let best = null;
        for (const a of agents.roots()) {
          const sid = a?.session?.header?.id;
          if (!sid) continue;
          const at = activity.get(String(sid))?.lastAt ?? 0;
          if (!best || at > best.at) {
            best = { sid: String(sid), at, cwd: a?.session?.header?.cwd || '' };
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
          const at = activity.get(String(sid))?.lastAt ?? 0;
          const created = Date.parse(s?.header?.createdAt || '') || 0;
          const score = at || created;
          if (!best || score > best.score) {
            best = { sid: String(sid), at, score, cwd: s?.header?.cwd || '' };
          }
        }
        if (best) return { sid: best.sid, cwd: best.cwd };
      }
    } catch {}
    // 最后兜底：纯活动表里最近的一条（可能是已结束会话，仅展示用）。
    let best = null;
    for (const [sid, info] of activity) {
      if (!best || info.lastAt > best.at) best = { sid, at: info.lastAt, cwd: info.cwd || '' };
    }
    return best ? { sid: best.sid, cwd: best.cwd } : null;
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
      touchActivity(sid);
      // 未绑定 + 有手机连接：首个根会话事件自动补绑（手机先开、电脑后干活的场景）。
      if (!boundSid && activeConn && st().enabled) {
        const roots = rootSessionIds();
        if (roots === null || roots.has(sid)) {
          bindSession({ sid, cwd: '' });
          sendFrame('bound', { sessionId: boundSid, cwd: boundCwd });
        }
      }
      if (!st().enabled || !activeConn || sid !== boundSid) return;
      const { frame, seq } = buildSessionFrame(sid, type, event?.data ?? {});
      activeConn.res.write(frame); // 直发完整帧（活动连接不走环形缓冲里的瘦身版）
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
      const status = String(payload?.status || '');
      const agent = payload?.agent;
      const sid = extractSessionId(payload);
      const cwd = agent?.session?.header?.cwd;
      touchActivity(sid, { status, ...(cwd ? { cwd } : {}) });
      if (!st().enabled || !activeConn) return;
      if (!boundSid && sid) {
        const roots = rootSessionIds();
        if (roots === null || roots.has(String(sid))) {
          bindSession({ sid: String(sid), cwd });
          sendFrame('bound', { sessionId: boundSid, cwd: boundCwd });
        }
      }
      if (sid && String(sid) === boundSid) {
        sendFrame('status', { sessionId: String(sid), status });
      }
    } catch (error) {
      console.error(PLUGIN_TAG, 'agent/status 处理异常:', msgOf(error));
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

  // 插件卸载：断开手机、挂起审批回落，避免留下悬挂 Promise。
  ctx.effect(() => () => {
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

  /** 从请求 Host 头取端口（自动拼局域网配对链接用）。 */
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
    let phone = '';
    let phoneSource = '';
    if (token) {
      if (s.publicBase) {
        phone = `${s.publicBase}${ROUTE_PREFIX}p/${token}`;
        phoneSource = 'publicBase';
      } else if (lan.length > 0) {
        phone = `http://${lan[0]}:${portOf(hostHeader)}${ROUTE_PREFIX}p/${token}`;
        phoneSource = 'auto-lan';
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
      active: activeConn ? 1 : 0,
      boundSession: boundSid,
      urls: { local, phone, phoneSource },
      lan,
      tailscale,
    };
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
          try {
            if (Object.keys(patch).length > 0) await settingsHandle.update(patch);
          } catch (error) {
            sendJson(res, 409, { ok: false, code: 'settings-rejected', message: msgOf(error) });
            return;
          }
          if (patch.enabled === true) await ensureToken();
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

          // 选定并绑定"电脑当前会话"。
          bindSession(pickSession());

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(': connected\n\n'); // 立即冲刷头部，确认链路
          const conn = { id: randomUUID().slice(0, 8), res, heartbeat: null };
          activeConn = conn;
          clearGraceTimer();

          // 断点补发：只补当前绑定会话、seq 大于游标的帧（P5：整页重载是主恢复路径）。
          if (boundSid && since !== null) {
            for (const item of ringFor(boundSid)) {
              if (item.seq > since) {
                try { res.write(item.frame); } catch {}
              }
            }
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

      // 5) 移动端单页：/mobile-remote/p/<token>，token 即路径段，错码 401。
      reg({
        kind: 'prefix',
        path: ROUTE_PREFIX,
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
    const s = st();
    console.log(PLUGIN_TAG, `ready; enabled=${s.enabled} token=${maskToken(s.token)}`
      + ` publicBase=${s.publicBase ? '已配置' : '未配置'} waitSec=${s.approvalWaitSec}`);
  });
}
