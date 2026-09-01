// probe 阶段 5a 探针插件（P7 上下文用量/缓存命中 · P8 运行时切模型 · P9 思考强度档位）
// ——只做实测与日志，不实现任何正式功能，不进发布包。
//
// 运行载体：独立 probe5a profile（dsh-base + dsh-headless [+ dsh-api-session-controller] + 本插件），
// 不触碰用户正在运行的 DSH web 实例；组合方式与阶段 0 probe 插件同构。
//
// 模式由环境变量 MR_PROBE5A_MODE 控制（决定注册哪个 probe_* 工具）：
//   p7 — probe_p7：tokenMeter.measure + tokenUsage/contextPressure/contextBreakdown 投影 +
//        resolveModel 上下文窗口/思考档位表 + 会话事件里的 usage 落点
//   p8 — probe_p8：模型目录枚举（listProviders/listModels）+ resolveCallConfig 校验 +
//        sessionController（官方切模型服务）可达性探测 + 在 agent 作用域安装 agent/request
//        改写（自下一请求起切到目标模型）+ 试追加 model/selection 会话事件（持久化路径）
//   p9 — probe_p9：当前模型 reasoning 档位表（efforts/defaultEffort）+ 在 agent 作用域安装
//        agent/request 改写注入 reasoningEffort（观察后续 request/header 是否落档位）
//
// 其余环境变量：
//   MR_PROBE5A_LOG            JSONL 日志落盘路径（逐行追加）
//   MR_PROBE5A_TARGET_MODEL   p8 目标模型 id（须与当前 provider 同源，如 GLM-4.7-Flash）
//   MR_PROBE5A_TARGET_EFFORT  p9 目标思考档位（如 low；特殊值 clear = 清除继承档位）
//
// 所有模式共享的观测器：session/event 全类型普查（P7 的证据面）、agent/status、
// 根作用域 agent/request 探针（只记日志不改写——验证插件根 ctx 能否看到该 waterfall）。

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

export const name = 'mobile-remote-probe5a';
export const inject = ['timer', 'tools'];

const MODE = process.env.MR_PROBE5A_MODE || 'p7';
const LOG = process.env.MR_PROBE5A_LOG || null;
const TARGET_MODEL = process.env.MR_PROBE5A_TARGET_MODEL || null;
const TARGET_EFFORT = process.env.MR_PROBE5A_TARGET_EFFORT || null;
// 改写风格：afterNext = await next() 后改写返回值（阶段 5a 首测，未生效）；veto = 不调 next() 直接返回完整配置（cordis 否决语义）
const REWRITE_STYLE = process.env.MR_PROBE5A_REWRITE || 'afterNext';

/** 逐行 JSON 落盘 + 控制台（与阶段 0 probe 插件同款）。 */
function log(event, data) {
  const line = JSON.stringify({ t: new Date().toISOString(), mode: MODE, event, ...data });
  if (LOG) {
    try { appendFileSync(LOG, line + '\n'); } catch {}
  }
  console.log('[probe5a]', line);
}

/** 加载 @deepseek-ai/dsh-llm（从运行中的 dsh 入口锚定解析，phone-push/阶段 0 同款）。 */
let llmCache;
async function loadLlm() {
  if (llmCache) return llmCache;
  const req = createRequire(process.argv[1] || import.meta.url);
  const resolved = req.resolve('@deepseek-ai/dsh-llm');
  llmCache = await import(pathToFileURL(resolved).href);
  return llmCache;
}

/** 安全 JSON 序列化（循环引用/超大对象防御）。 */
function safeJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
}

/** 从事件载荷防御式提取会话 id。 */
function extractSessionId(payload) {
  try {
    const session = payload?.session || payload?.agent?.session;
    const sid = session?.header?.id || payload?.sessionId;
    return sid !== undefined ? String(sid) : '?';
  } catch { return '?'; }
}

export function apply(ctx) {
  log('plugin-apply', { pid: process.pid, argv1: process.argv[1] });

  // ── 共享观测器 1：session/event 全类型普查（P7 事件面证据）──────────────────
  // assistant/message（usage 落点）、request/header（生效请求头，P8/P9 观测点）、
  // model/selection（切换持久化事件）全量落日志；其余类型只记 type 普查。
  ctx.on('session/event', (subject, event) => {
    try {
      const sid = String(subject?.header?.id || subject?.id || '?');
      const type = String(event?.type || '?');
      if (type === 'assistant/message') {
        log('session/event/assistant-message', {
          session: sid,
          turn: event?.data?.turn,
          step: event?.data?.step,
          interrupted: event?.data?.interrupted,
          usage: safeJson(event?.data?.usage) ?? null,
          source: safeJson(event?.data?.message?.source) ?? null,
          blockTypes: Array.isArray(event?.data?.message?.content)
            ? event.data.message.content.map((b) => b?.type) : undefined,
        });
      } else if (type === 'request/header') {
        log('session/event/request-header', { session: sid, data: safeJson(event?.data) });
      } else if (type === 'model/selection') {
        log('session/event/model-selection', { session: sid, data: safeJson(event?.data) });
      } else if (type === 'turn/start' || type === 'turn/end' || type === 'user/message') {
        log('session/event/key', { session: sid, type, data: safeJson(event?.data) });
      } else {
        log('session/event/census', { session: sid, type });
      }
    } catch (e) {
      log('session/event-error', { error: String(e) });
    }
  });

  // ── 共享观测器 2：agent/status（轮边界与运行态）──────────────────────────────
  ctx.on('agent/status', (payload) => {
    try {
      log('agent/status', {
        status: String(payload?.status),
        session: extractSessionId(payload),
      });
    } catch (e) {
      log('agent/status-error', { error: String(e) });
    }
  });

  // ── 共享观测器 3：根作用域 agent/request 探针（只记日志不改写）────────────────
  // 目的：验证插件的根 ctx 能否看到 agent/request waterfall——若能看到，
  // 5b 的自实现切换可以只靠根作用域监听（无需拿到 agent 对象）。
  // 同时记录 next() 的返回值：判别「改写值被 loop 丢弃」还是「改写监听器不在同一条链」。
  let rootRequestSeen = 0;
  ctx.on('agent/request', async (payload, next) => {
    rootRequestSeen += 1;
    const n = rootRequestSeen;
    log('agent/request/root-seen', {
      n,
      provider: payload?.provider,
      model: payload?.model,
      reasoningEffort: payload?.reasoningEffort,
    });
    const downstream = await next();
    log('agent/request/root-downstream', {
      n,
      downstream: { provider: downstream?.provider, model: downstream?.model, reasoningEffort: downstream?.reasoningEffort },
    });
    return downstream;
  });

  // ── 公共读取助手：当前生效的 provider/model（requestHeader 优先，消息 source 兜底）──
  function currentRoute(session) {
    try {
      const header = session.requestHeader?.();
      if (header?.config?.provider && header?.config?.model) {
        return {
          provider: header.config.provider,
          model: header.config.model,
          reasoningEffort: header.config.reasoningEffort,
          adapterDefaults: safeJson(header.adapterDefaults) ?? null,
          from: 'requestHeader',
        };
      }
    } catch (e) {
      log('current-route/requestHeader-error', { error: String(e) });
    }
    // 兜底：扫会话事件里最近一条 assistant/message 的 source
    try {
      const events = Array.isArray(session.events) ? session.events : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev?.type === 'assistant/message') {
          const src = ev?.data?.message?.source;
          if (src?.provider && src?.model) {
            return { provider: src.provider, model: src.model, from: 'assistant-message-source' };
          }
        }
      }
    } catch {}
    return null;
  }

  // ── 工具 1：probe_p7（上下文用量 / 缓存命中 / 容量）──────────────────────────
  if (MODE === 'p7') {
    ctx.tools.register({
      name: 'probe_p7',
      description: 'probe 工具：读取 tokenMeter 度量、三个 usage 投影、模型上下文窗口与会话事件 usage。仅用于阶段 5a 探针。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        },
        render: (_args, value) => [{ type: 'text', text: `probe_p7: ${String(value?.note)}——请只回复「P7-DONE」。` }],
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session;
        const out = {};
        // 1) tokenMeter 服务：measure() 给当前请求压力/表面用量
        try {
          const meter = ctx.get('tokenMeter');
          out.tokenMeterMounted = meter !== undefined;
          if (meter && typeof meter.measure === 'function' && session) {
            out.measure = safeJson(meter.measure(session));
          }
        } catch (e) { out.measureError = String(e); }
        // 2) 三个投影的当前状态（web 端上下文条的同源数据）
        try {
          const projections = ctx.get('sessionProjections');
          out.sessionProjectionsMounted = projections !== undefined;
          if (projections && session) {
            for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown', 'modelSelection']) {
              try { out[`projection_${key}`] = safeJson(projections.stateOf?.(session, key)) ?? null; }
              catch (e) { out[`projection_${key}`] = { error: String(e) }; }
            }
          }
        } catch (e) { out.projectionError = String(e); }
        // 3) 模型目录与容量：resolveModel 的 context.contextWindow / reasoning 档位表
        try {
          const llm = ctx.get('llm');
          out.llmMounted = llm !== undefined;
          const route = currentRoute(session);
          out.currentRoute = route;
          if (llm && route) {
            const info = await llm.resolveModelInfo(route.provider, route.model);
            out.resolvedModel = safeJson({
              id: info?.id, name: info?.name,
              context: info?.context ?? null,
              reasoning: info?.reasoning ?? null,
              defaultMaxTokens: info?.defaultMaxTokens ?? null,
            });
          }
          if (llm && typeof llm.listProviders === 'function') {
            out.providers = safeJson(await llm.listProviders());
          }
        } catch (e) { out.modelInfoError = String(e); }
        // 4) 会话事件流里的 usage 落点：当前会话所有 assistant/message 的 usage
        try {
          const events = Array.isArray(session?.events) ? session.events : [];
          out.assistantUsageEvents = events
            .filter((ev) => ev?.type === 'assistant/message')
            .map((ev) => ({ seq: ev.seq, usage: safeJson(ev?.data?.usage) ?? null, source: safeJson(ev?.data?.message?.source) ?? null }));
          out.eventTypeCensus = events.reduce((acc, ev) => {
            const t = String(ev?.type || '?'); acc[t] = (acc[t] || 0) + 1; return acc;
          }, {});
        } catch (e) { out.eventScanError = String(e); }
        log('probe_p7/result', { result: out });
        return { ok: true, note: `tokenMeter=${out.tokenMeterMounted ? '已挂载' : '未挂载'} measureKind=${out.measure?.baseline?.kind ?? '?'}` };
      },
    });
  }

  // ── 工具 2：probe_p8（运行时切模型：目录/校验/官方服务可达性/自实现改写）────────
  if (MODE === 'p8') {
    ctx.tools.register({
      name: 'probe_p8',
      description: 'probe 工具：枚举模型目录、校验目标模型、探测 sessionController 可达性，并安装 agent/request 改写使下一个请求切换模型。仅用于阶段 5a 探针。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        },
        render: (_args, value) => [{ type: 'text', text: `probe_p8: ${String(value?.note)}——请只回复「P8-DONE」。` }],
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session;
        const out = {};
        // 1) 模型目录：providers 与当前 provider 的 models
        try {
          const llm = ctx.get('llm');
          out.providers = safeJson(await llm.listProviders());
          const route = currentRoute(session);
          out.currentRoute = route;
          if (route) {
            out.models = safeJson(await llm.listModels(route.provider));
            // 2) 目标模型校验：resolveCallConfig 会做路由/别名/存在性归一
            out.resolveCurrent = safeJson(await llm.resolveCallConfig({ provider: route.provider, model: route.model }));
            if (TARGET_MODEL) {
              try {
                out.resolveTarget = safeJson(await llm.resolveCallConfig({ provider: route.provider, model: TARGET_MODEL }));
              } catch (e) { out.resolveTargetError = String(e); }
            }
          }
        } catch (e) { out.catalogError = String(e); }
        // 3) 官方切模型服务可达性（web 组合挂载；headless 视装配而定）
        try {
          const sc = ctx.get('sessionController');
          out.sessionControllerMounted = sc !== undefined;
          if (sc) {
            out.sessionControllerShape = {
              hasCommands: !!sc.commands,
              hasAgents: !!sc.agents,
              agentsHasSelectForNextRequest: typeof sc.agents?.selectForNextRequest === 'function',
            };
          }
          const adm = ctx.get('agentDefaultModel');
          out.agentDefaultModelMounted = adm !== undefined;
        } catch (e) { out.officialProbeError = String(e); }
        // 4) 持久化路径试写：追加 model/selection 会话事件（内建事件类型，
        //    modelSelection 投影会折叠它；不影响运行中 agent 的内存选择）
        try {
          if (session && TARGET_MODEL && currentRoute(session)) {
            const route = currentRoute(session);
            const appended = session.append('model/selection', {
              provider: route.provider,
              model: TARGET_MODEL,
            });
            out.modelSelectionAppend = { ok: true, seq: appended?.seq };
          }
        } catch (e) { out.modelSelectionAppend = { ok: false, error: String(e) }; }
        // 5) 自实现切换：在 agent 作用域安装 agent/request 改写（镜像宿主
        //    installModelSelection 的 request 侧 waterfall），自下一请求生效；
        //    最多改写 3 次防失控。system-prompt/assemble 侧本次不镜像（探针只验证机制）。
        //    REWRITE_STYLE=veto 时不调 next()、直接返回完整配置（cordis 否决语义：返回值即最终值）。
        if (TARGET_MODEL && exec?.agent?.ctx) {
          const route = currentRoute(session);
          let applied = 0;
          exec.agent.ctx.on('agent/request', async (_payload, next) => {
            if (REWRITE_STYLE === 'veto') {
              if (applied >= 3) return next();
              applied += 1;
              log('agent/request/rewrite', {
                scope: 'agent-ctx', style: 'veto',
                after: { provider: route?.provider, model: TARGET_MODEL },
              });
              return { provider: route?.provider, model: TARGET_MODEL };
            }
            const resolved = await next();
            if (applied >= 3 || !resolved) return resolved;
            applied += 1;
            log('agent/request/rewrite', {
              scope: 'agent-ctx', style: 'afterNext',
              before: { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort },
              after: { provider: resolved.provider, model: TARGET_MODEL },
            });
            return { ...resolved, model: TARGET_MODEL };
          });
          out.rewriteInstalled = { style: REWRITE_STYLE, baseProvider: route?.provider };
        }
        log('probe_p8/result', { result: out });
        return { ok: true, note: `provider=${out.currentRoute?.provider ?? '?'} 目标=${TARGET_MODEL ?? '未设'} rewrite=${out.rewriteInstalled ? '已装' : '未装'}` };
      },
    });
  }

  // ── 工具 3：probe_p9（思考强度档位）─────────────────────────────────────────
  if (MODE === 'p9') {
    ctx.tools.register({
      name: 'probe_p9',
      description: 'probe 工具：读取当前模型 reasoning 档位表，并安装 agent/request 改写注入 reasoningEffort 观察落档情况。仅用于阶段 5a 探针。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
        },
        render: (_args, value) => [{ type: 'text', text: `probe_p9: ${String(value?.note)}——请只回复「P9-DONE」。` }],
      },
      async execute(_args, exec) {
        const session = exec?.agent?.session;
        const out = {};
        // 1) 当前模型的 reasoning 档位表（efforts[id/name/description] + defaultEffort）
        try {
          const llm = ctx.get('llm');
          const route = currentRoute(session);
          out.currentRoute = route;
          if (llm && route) {
            const info = await llm.resolveModelInfo(route.provider, route.model);
            out.reasoning = safeJson(info?.reasoning) ?? null;
            out.context = safeJson(info?.context) ?? null;
          }
        } catch (e) { out.reasoningProbeError = String(e); }
        // 2) 自实现档位注入：agent 作用域 agent/request 改写，把 reasoningEffort
        //    设为目标档位（clear 则删除键，验证「清除继承档位」语义）；
        //    下一请求的 request/header 会话事件应携带该档位。
        //    REWRITE_STYLE=veto 时不调 next()、直接返回完整配置（cordis 否决语义）。
        if (TARGET_EFFORT && exec?.agent?.ctx) {
          const route = currentRoute(session);
          let applied = 0;
          exec.agent.ctx.on('agent/request', async (_payload, next) => {
            if (REWRITE_STYLE === 'veto') {
              if (applied >= 3) return next();
              applied += 1;
              log('agent/request/rewrite', {
                scope: 'agent-ctx', style: 'veto',
                after: { provider: route?.provider, model: route?.model, reasoningEffort: TARGET_EFFORT === 'clear' ? undefined : TARGET_EFFORT },
              });
              const config = { provider: route?.provider, model: route?.model };
              if (TARGET_EFFORT !== 'clear') config.reasoningEffort = TARGET_EFFORT;
              return config;
            }
            const resolved = await next();
            if (applied >= 3 || !resolved) return resolved;
            applied += 1;
            const nextConfig = { ...resolved };
            if (TARGET_EFFORT === 'clear') delete nextConfig.reasoningEffort;
            else nextConfig.reasoningEffort = TARGET_EFFORT;
            log('agent/request/rewrite', {
              scope: 'agent-ctx', style: 'afterNext',
              before: { provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort },
              after: { provider: nextConfig.provider, model: nextConfig.model, reasoningEffort: nextConfig.reasoningEffort },
            });
            return nextConfig;
          });
          out.rewriteInstalled = { style: REWRITE_STYLE, target: TARGET_EFFORT };
        }
        log('probe_p9/result', { result: out });
        return { ok: true, note: `efforts=${out.reasoning?.efforts ? out.reasoning.efforts.map((x) => x.id).join('|') : '无'} 目标=${TARGET_EFFORT ?? '未设'}` };
      },
    });
  }

  log('plugin-ready', { mode: MODE, targetModel: TARGET_MODEL, targetEffort: TARGET_EFFORT });
}
