// probe P10 探针插件：DSH 是否有创建会话的 API/service（sessionController.create 或等价物）。
// ——只做实测与日志，不实现任何正式功能，不进发布包。
//
// 运行载体：独立 probe10 profile（dsh-base + dsh-headless + 本插件；本插件 patch 再插入
// dsh-api-session-controller 行，与生产 dsh-web-app 的组合方式一致）。不触碰运行中的
// Desktop/web 实例。
//
// 实测项（工具 probe_p10，由模型调用触发）：
//   A. ctx.get('sessionController') 可达性（web 组合行在 headless+补行组合里是否挂载）
//   B. sc.create({ cwd }) —— 官方 create（Remote("create")）能否由插件直调，返回什么
//      （fallback：sc.commands.create —— SessionCommandController.create 同参）
//   C. 新会话是否进入 live 注册表：sessions.list() / agents.get(sid) / sessionQuery.listSessions()
//   D. 生产 steer 路径复用：createUserMessage(source plugin:'mobile-remote-probe10') +
//      agent.steer(msg) —— 全新空闲会话（从未有过轮次）能否被 steer 唤醒出首轮
//   E. session/created 事件是否发出（桌面 UI 感知新建会话的机制）
//
// 环境变量：MR_PROBE10_LOG —— JSONL 日志落盘路径。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

export const name = 'mobile-remote-probe10';
export const inject = ['timer', 'tools'];

const LOG = process.env.MR_PROBE10_LOG || null;
// steer 目标提示（不调用任何工具，纯文本回复，避免审批干扰）
const STEER_TEXT = 'P10 探针：请只回复四个字符 P10-OK，不要做任何其他事情。';

function log(event, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  if (LOG) {
    try { appendFileSync(LOG, line + '\n'); } catch {}
  }
  console.log('[probe10]', line);
}

function safeJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

/** 加载 @deepseek-ai/dsh-llm（从运行中的 dsh 入口锚定解析，probe5a 同款）。 */
let llmCache;
async function loadLlm() {
  if (llmCache) return llmCache;
  const req = createRequire(process.argv[1] || import.meta.url);
  const resolved = req.resolve('@deepseek-ai/dsh-llm');
  llmCache = await import(pathToFileURL(resolved).href);
  return llmCache;
}

export function apply(ctx) {
  log('plugin-apply', { pid: process.pid });

  // ── 观测器：session/created（E 项）+ session/event 普查 + agent/status ──────
  ctx.on('session/created', (session) => {
    log('session/created', { sid: safeJson(session?.header?.id), cwd: safeJson(session?.header?.cwd) });
  });
  ctx.on('session/event', (subject, event) => {
    try {
      const sid = String(subject?.header?.id || subject?.id || '?');
      const type = String(event?.type || '?');
      if (type === 'assistant/message' || type === 'user/message' || type === 'turn/start' || type === 'turn/end') {
        log('session/event/key', { session: sid, type, seq: event?.seq });
      }
    } catch {}
  });
  ctx.on('agent/status', (payload) => {
    try {
      log('agent/status', { status: String(payload?.status), sid: safeJson(payload?.agent?.session?.header?.id) });
    } catch {}
  });

  ctx.tools.register({
    name: 'probe_p10',
    description: 'probe 工具：实测 sessionController.create 创建会话 + 全新会话 steer 唤醒。仅用于 P10 探针。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: `probe_p10: ${String(value?.note)}——请只回复「P10-DONE」。` }],
    },
    async execute(_args, exec) {
      const out = {};
      const cwd = 'D:\\dsh-plugins\\mobile-remote\\probe\\workspace';

      // A. sessionController 可达性
      let sc;
      try {
        sc = ctx.get('sessionController');
        out.sessionControllerMounted = sc !== undefined;
        out.shape = { hasCreate: typeof sc?.create === 'function', hasCommandsCreate: typeof sc?.commands?.create === 'function' };
      } catch (e) {
        out.sessionControllerError = String(e);
      }
      if (!sc) {
        log('probe_p10/result', { result: out });
        return { ok: false, note: 'sessionController 不可达' };
      }

      // B. 官方 create（cwd 形态——不依赖 workspaceId）
      let sid = null;
      try {
        const created = await sc.create({ cwd });
        sid = String(created?.sessionId || '');
        out.create = { ok: true, returned: safeJson(created) };
      } catch (e) {
        out.create = { ok: false, error: String(e) };
        // fallback：commands.create（同一请求形状）
        try {
          const created = await sc.commands.create({ cwd });
          sid = String(created?.sessionId || '');
          out.createFallbackCommands = { ok: true, returned: safeJson(created) };
        } catch (e2) {
          out.createFallbackCommands = { ok: false, error: String(e2) };
        }
      }
      log('probe_p10/create', { sid, out: safeJson(out.create) });
      if (!sid) {
        log('probe_p10/result', { result: out });
        return { ok: false, note: 'create 未产出 sessionId' };
      }

      // C. live 注册表三路核对
      try {
        const store = ctx.get('sessions');
        out.liveList = (store?.list?.() || []).some((s) => String(s?.header?.id) === sid);
        const agents = ctx.get('agents');
        const agent = agents && typeof agents.get === 'function' ? agents.get(sid) : undefined;
        out.agentsGet = agent ? { ok: true, sessionCwd: safeJson(agent?.session?.header?.cwd) } : { ok: false };
        out.agentHasSteer = typeof agent?.steer === 'function';
        const q = ctx.get('sessionQuery');
        if (q && typeof q.listSessions === 'function') {
          const all = await q.listSessions();
          const rec = (Array.isArray(all) ? all : []).find((r) => String(r?.header?.id) === sid);
          out.sessionQuery = rec ? { live: rec.live === true, persisted: rec.persisted === true } : { found: false };
        }
      } catch (e) {
        out.registryError = String(e);
      }

      // D. 生产 steer 路径：全新空闲会话被 steer 唤醒出首轮
      try {
        const llmMod = await loadLlm();
        const agent = ctx.get('agents').get(sid);
        if (agent && typeof agent.steer === 'function') {
          const msg = llmMod.createUserMessage({
            content: [{ type: 'text', text: STEER_TEXT }],
            source: { kind: 'plugin', plugin: 'mobile-remote-probe10' },
          });
          agent.steer(msg);
          out.steer = { ok: true };
          // 轮询新会话事件：出现 assistant/message 即证明首轮真实运行并被消费
          const deadline = Date.now() + 60000;
          let sawUser = false;
          let sawAssistant = false;
          while (Date.now() < deadline && !sawAssistant) {
            await ctx.timeout(1500);
            try {
              const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
              for (const ev of events) {
                if (ev?.type === 'user/message') sawUser = true;
                if (ev?.type === 'assistant/message') sawAssistant = true;
              }
            } catch {}
          }
          out.steerWake = { sawUserMessage: sawUser, sawAssistantMessage: sawAssistant };
        } else {
          out.steer = { ok: false, reason: 'agent 或 steer 不可用' };
        }
      } catch (e) {
        out.steer = { ok: false, error: String(e) };
      }

      log('probe_p10/result', { result: safeJson(out) });
      const okCreate = out.create?.ok || out.createFallbackCommands?.ok;
      const okWake = out.steerWake?.sawAssistantMessage === true;
      return {
        ok: Boolean(okCreate),
        note: `create=${okCreate ? '成功' : '失败'} sid=${sid ? sid.slice(0, 16) + '…' : '?'} live=${out.liveList} steer唤醒=${okWake ? '有首轮回复' : '未见回复'}`,
      };
    },
  });

  log('plugin-ready', {});
}
