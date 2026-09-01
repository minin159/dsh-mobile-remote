// probe 阶段 0 探针插件（P2/P3/P4）——只做实测与日志，不实现任何正式功能。
//
// 运行载体：独立 probe profile（dsh-headless 组合），不触碰用户正在运行的 DSH 实例。
// 模式由环境变量 MOBILE_REMOTE_PROBE_MODE 控制：
//   p2        — P2 探针：probe_p2 工具内连续多次 agent.steer（0s/1s/11s）+ 空闲后补发
//   p3-allow  — P3 探针：approval/request 水fall 回 'allowed-once'
//   p3-reject — P3 探针：回 'rejected'
//   p3-none   — P3 探针：next() 交回原应答链（headless 无其他应答者 → 应得 unavailable）
//   p3-hang   — P3 探针：handler 挂起 20s（request 端带 25s abort 信号 → 应得 cancelled）
//   p4        — P4 探针：probe_p4 工具枚举 sessions / sessionQuery
// 日志：MOBILE_REMOTE_PROBE_LOG 指定文件（fs.appendFileSync，逐行 JSON）。
//
// 参考（只读）：phone-push dsh/index.js 已验证的 inject/事件/steer/工具注册用法。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

export const name = 'mobile-remote-probe';
export const inject = ['timer', 'tools'];

const MODE = process.env.MOBILE_REMOTE_PROBE_MODE || 'p4';
const LOG = process.env.MOBILE_REMOTE_PROBE_LOG || null;

/** 逐行 JSON 落盘 + 控制台。 */
function log(event, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), mode: MODE, event, ...data });
  if (LOG) {
    try { appendFileSync(LOG, line + '\n'); } catch {}
  }
  console.log('[probe]', line);
}

/** 加载 @deepseek-ai/dsh-llm（phone-push 同款：从运行中的 dsh 入口锚定解析）。 */
let llmCache;
async function loadLlm() {
  if (llmCache) return llmCache;
  const req = createRequire(process.argv[1] || import.meta.url);
  const resolved = req.resolve('@deepseek-ai/dsh-llm');
  llmCache = await import(pathToFileURL(resolved).href);
  return llmCache;
}

/** 从事件载荷防御式提取会话 id（phone-push 同款）。 */
function extractSessionId(payload) {
  try {
    const agent = payload && typeof payload === 'object' ? payload.agent : undefined;
    const session = payload?.session || agent?.session;
    const sid = session?.header?.id || payload?.sessionId || session?.id || agent?.id;
    return sid !== undefined ? String(sid) : '?';
  } catch {
    return '?';
  }
}

export function apply(ctx) {
  log('plugin-apply', { pid: process.pid, argv1: process.argv[1] });

  // ── 通用观察器：agent/status 与 session/event（P2/P4 的证据来源）────────────
  ctx.on('agent/status', (payload) => {
    try {
      log('agent/status', {
        status: String(payload?.status),
        session: extractSessionId(payload),
        hasSteer: !!(payload?.agent && typeof payload.agent.steer === 'function'),
      });
    } catch (e) {
      log('agent/status-error', { error: String(e) });
    }
  });

  ctx.on('session/event', (subject, event) => {
    try {
      const sid = String(subject?.header?.id || subject?.id || '?');
      const type = String(event?.type || '?');
      // 只记录关键事件，避免日志爆炸：轮边界、用户消息（steer 落点）、审批审计
      if (type === 'turn/start' || type === 'turn/end' || type === 'approval/asked' || type === 'approval/decided') {
        log('session/event', { session: sid, type, data: event?.data });
      } else if (type === 'user/message') {
        log('session/event', { session: sid, type, data: event?.data });
      }
    } catch (e) {
      log('session/event-error', { error: String(e) });
    }
  });

  // ── P3：approval/request handler（模式决定行为）────────────────────────────
  ctx.on('approval/request', async (req, next) => {
    log('approval/request-received', { toolName: req?.toolName, reason: req?.reason });
    if (MODE === 'p3-allow') {
      log('approval/decide', { decision: 'allowed-once' });
      return 'allowed-once';
    }
    if (MODE === 'p3-reject') {
      log('approval/decide', { decision: 'rejected' });
      return 'rejected';
    }
    if (MODE === 'p3-hang') {
      // 挂起 30 秒（> 调用方 25s abort）：验证「handler 挂起会阻塞请求 + abort 关闭为 cancelled」
      log('approval/hang-begin', { holdMs: 30000 });
      await new Promise((r) => setTimeout(r, 30000));
      log('approval/hang-end', {});
      return next();
    }
    return next(); // p3-none / p2 / p4：交回原应答链
  });

  // ── P3：probe_gate 工具——经真实 approval 服务发起请求并回传结果 ─────────────
  ctx.tools.register({
    name: 'probe_gate',
    description: 'probe 工具：发起一次真实的 approval.request 并返回其决定值。仅用于阶段 0 探针。',
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
      render: (_args, value) => [{ type: 'text', text: 'approval outcome: ' + String(value?.outcome) }],
    },
    async execute(_args, exec) {
      const approval = ctx.get('approval');
      log('probe_gate/begin', { hasApprovalService: approval !== undefined, session: extractSessionId(exec) });
      if (!approval || typeof approval.request !== 'function') {
        return { ok: false, outcome: 'approval-service-missing' };
      }
      const t0 = Date.now();
      try {
        // p3-hang 模式带 25s abort 信号（验证挂起 + 中止语义）；其余模式无信号
        const signal = MODE === 'p3-hang' ? AbortSignal.timeout(25000) : undefined;
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'probe_gate',
          reason: 'probe P3：审批语义实测（allowed-once/rejected/unavailable/cancelled）',
          ...(signal ? { signal } : {}),
        });
        log('probe_gate/outcome', { outcome: String(outcome), elapsedMs: Date.now() - t0 });
        return { ok: outcome === 'allowed-once', outcome: String(outcome) };
      } catch (e) {
        log('probe_gate/error', { error: String(e), elapsedMs: Date.now() - t0 });
        return { ok: false, outcome: 'error: ' + String(e) };
      }
    },
  });

  // ── P2：probe_p2 工具——运行中连续 steer；空闲后的补发由 agent/status 监听器触发 ──
  let idleSteerCount = 0; // 空闲补发最多 2 次，防止无限循环
  let sawFirstIdle = false;
  ctx.on('agent/status', (payload) => {
    if (MODE !== 'p2' || String(payload?.status) !== 'idle') return;
    if (idleSteerCount >= 2) return;
    sawFirstIdle = true;
    const agent = payload.agent;
    if (!agent || typeof agent.steer !== 'function') return;
    const n = ++idleSteerCount;
    const delayMs = n === 1 ? 1500 : 11500; // 空闲后 1.5s 补发 #4；其回复结束再等 10s 补发 #5
    setTimeout(async () => {
      try {
        const llm = await loadLlm();
        log('idle-steer/send', { n: n + 3, delayMs, session: extractSessionId(payload) });
        agent.steer(llm.createUserMessage({
          content: [{ type: 'text', text: `探针空闲消息${n + 3}：请只回复「${n + 3}-收到」，不要调用任何工具。` }],
          source: { kind: 'plugin', plugin: 'mobile-remote-probe' },
        }));
        log('idle-steer/sent', { n: n + 3 });
      } catch (e) {
        log('idle-steer/error', { n: n + 3, error: String(e) });
      }
    }, delayMs);
  });

  ctx.tools.register({
    name: 'probe_p2',
    description: 'probe 工具：在当前运行中的会话上连续多次 agent.steer 并记录结果。仅用于阶段 0 探针。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, steered: { type: 'number' } },
        required: ['ok', 'steered'],
      },
      render: (_args, value) => [{ type: 'text', text: `probe_p2: 已连续 steer ${value?.steered} 次；请直接回复「P2-DONE」。` }],
    },
    async execute(_args, exec) {
      const agent = exec?.agent;
      const llm = await loadLlm();
      const canSteer = !!(agent && typeof agent.steer === 'function');
      log('probe_p2/begin', { canSteer, session: extractSessionId(exec) });
      if (!canSteer) return { ok: false, steered: 0 };
      const gaps = [0, 1000, 10000]; // 间隔 1s / 10s（任务规格要求）
      let n = 0;
      for (const gap of gaps) {
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        n += 1;
        try {
          agent.steer(llm.createUserMessage({
            content: [{ type: 'text', text: `探针消息${n}：请只回复「${n}-收到」，不要调用任何工具。` }],
            source: { kind: 'plugin', plugin: 'mobile-remote-probe' },
          }));
          log('probe_p2/steered', { n, gapMs: gap });
        } catch (e) {
          log('probe_p2/steer-error', { n, error: String(e) });
        }
      }
      return { ok: true, steered: n };
    },
  });

  // ── P4：probe_p4 工具——会话枚举与标识实测 ─────────────────────────────────
  ctx.tools.register({
    name: 'probe_p4',
    description: 'probe 工具：枚举当前宿主内的会话（sessions 服务与 sessionQuery 服务）并返回结果。仅用于阶段 0 探针。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          currentSession: { type: 'string' },
          liveCount: { type: 'number' },
          queryMounted: { type: 'boolean' },
        },
        required: ['ok', 'currentSession', 'liveCount', 'queryMounted'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `probe_p4: 当前会话=${value?.currentSession} live=${value?.liveCount} sessionQuery=${value?.queryMounted ? '已挂载' : '未挂载'}`,
      }],
    },
    async execute(_args, exec) {
      const current = exec?.agent?.session?.header?.id;
      const store = ctx.get('sessions');
      let live = null;
      if (store && typeof store.list === 'function') {
        live = store.list().map((s) => ({
          id: s?.header?.id,
          createdAt: s?.header?.createdAt,
          cwd: s?.header?.cwd,
          events: Array.isArray(s?.events) ? s.events.length : undefined,
        }));
      }
      const query = ctx.get('sessionQuery');
      let listed = null;
      if (query && typeof query.listSessions === 'function') {
        try {
          const all = await query.listSessions();
          listed = {
            total: all.length,
            sample: all.slice(0, 3).map((r) => ({
              id: r?.header?.id ?? r?.id,
              live: r?.live,
              persisted: r?.persisted,
              cwd: r?.header?.cwd,
              rawKeys: r && typeof r === 'object' ? Object.keys(r) : undefined,
            })),
          };
        } catch (e) {
          listed = { error: String(e) };
        }
      }
      log('probe_p4/result', { current, live, sessionQuery: listed });
      return {
        ok: true,
        currentSession: current !== undefined ? String(current) : '?',
        liveCount: Array.isArray(live) ? live.length : -1,
        queryMounted: !!(query && typeof query.listSessions === 'function'),
      };
    },
  });

  log('plugin-ready', { mode: MODE });
}
