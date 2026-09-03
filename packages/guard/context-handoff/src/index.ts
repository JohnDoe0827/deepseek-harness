/**
 * Context-bloat handoff observer.
 *
 * Runs on its own clock (a `setInterval` independent of the agent timeline)
 * and measures each live session's token pressure with the token meter. When
 * `totalTokens` reaches `thresholdRatio * contextWindow` for the session's
 * routed model, it appends a durable `context/handoff` notice and injects a
 * model-visible reminder naming the `dsh-context-handoff` skill — the agent
 * then backs up the project and conversation and prompts the user to open a
 * fresh session. This observer does not compact and does not touch the
 * filesystem; it only detects the bloat boundary and hands the continuation
 * work to the agent via the skill.
 *
 * The measure-then-notice ordering is a package invariant: every
 * `context/handoff` event's `totalTokens` must be at least its
 * `thresholdTokens`, so a notice is only ever written after a real pressure
 * measurement crossed the boundary.
 *
 * @module @deepseek-ai/dsh-context-handoff
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
// Type-only edge: resolve ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'

export const name = 'context-handoff'
export const inject = ['agents', 'llm', 'tokenMeter', 'agentDefaultModel']

/** Durable payload of one `context/handoff` event. */
export interface ContextHandoffNoticeData {
  /** Session name the routed model targets (provider/model key). */
  target: string
  /** Measured request-and-response pressure when the boundary crossed. */
  totalTokens: number
  /** Adapter-owned model capacity for the routed target. */
  contextWindow: number
  /** `floor(contextWindow * thresholdRatio)`: the boundary that tripped. */
  thresholdTokens: number
  /** Configured pressure fraction of the context window. */
  ratio: number
  /** Human-readable boundary fact, e.g. `612340 >= 600000 (0.6 of 1000000)`. */
  reason: string
  /** Handoff cycle number: 0 for the first session, incremented by the next session's config. */
  cycle: number
}

/** Deployment-owned config: the single pressure boundary and cadence. */
export interface Config {
  /** Evaluate pressure on this cadence, in ms (default 10000). */
  tickMs?: number
  /** Fraction of the routed model's context window that trips a handoff (default 0.6). */
  thresholdRatio?: number
  /** Handoff cycle number; the fresh session config sets it one past the previous session's last notice (default 0). */
  cycle?: number
}

export const Config: z<Config> = z.object({
  tickMs: z.number().default(10_000),
  thresholdRatio: z.number().default(0.6),
  cycle: z.number().default(0),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One context-bloat handoff notice. `target` names the routed model,
     * `totalTokens`/`contextWindow`/`thresholdTokens` the measured pressure
     * and its boundary, `ratio` the configured fraction, and `reason` the
     * readable boundary fact.
     * @mode durable, model-visible adjacency: this event is the record of the
     * reminder the agent received.
     */
    'context/handoff': ContextHandoffNoticeData
  }
}

/** Per-session state: whether this session already requested a handoff. */
interface ObserverState {
  fired: boolean
}

/** Resolve the routed provider/model key for a session's default route. */
function targetKey(
  ctx: Context,
): { provider: string; model: string; key: string } {
  const route = ctx.agentDefaultModel.currentSelection()
  const provider = route.provider
  const model = route.model
  return { provider, model, key: `${provider}/${model}` }
}

/** Resolved plugin configuration: defaults applied, all fields concrete. */
type ResolvedConfig = { tickMs: number; thresholdRatio: number; cycle: number }

/**
 * Register the context-handoff observer: a clock that measures live session
 * pressure and, past the threshold, records a durable notice and injects the
 * skill reminder.
 * @param ctx - registrant context with token meter, llm, and the agent registry.
 * @param config - deployment-owned handoff threshold config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg: ResolvedConfig = {
    tickMs: config.tickMs ?? 10_000,
    thresholdRatio: config.thresholdRatio ?? 0.6,
    cycle: config.cycle ?? 0,
  }
  ctx.effect(function* () {
    const states = new WeakMap<Session, ObserverState>()
    // Model capacity is a per-target constant; resolve once and reuse.
    const windows = new Map<string, { window: number; threshold: number }>()

    function stateFor(session: Session): ObserverState {
      let state = states.get(session)
      if (state === undefined) {
        state = { fired: false }
        states.set(session, state)
      }
      return state
    }

    ctx.on('agent/created', ({ agent }) => {
      stateFor(agent.session)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent.session)
    })

    const timer = setInterval(() => {
      const agents = ctx.agents.list()
      for (const agent of agents) {
        const session = agent.session
        const state = stateFor(session)
        if (state.fired) continue
        const measurement: TokenMeasurement = ctx.tokenMeter.measure(session)
        if (measurement.totalTokens === 0) continue
        const { provider, model, key } = targetKey(ctx)
        const cap = windows.get(key)
        if (cap === undefined) {
          void ctx.llm.resolveModelInfo(provider, model, new AbortController().signal).then((info) => {
            const window = info.context?.contextWindow
            if (window === undefined || window <= 0) return
            const threshold = Math.floor(window * cfg.thresholdRatio)
            windows.set(key, { window, threshold })
            check(agent, state, measurement, key, window, threshold, cfg.thresholdRatio, cfg.cycle)
          }).catch(() => { /* a transient model-info failure defers to the next tick */ })
          continue
        }
        check(agent, state, measurement, key, cap.window, cap.threshold, cfg.thresholdRatio, cfg.cycle)
      }
    }, cfg.tickMs)

    yield () => { clearInterval(timer) }
  })
}

/**
 * Measure-then-notice: fire only when the measurement provably crossed the
 * boundary. Appends the durable `context/handoff` notice and injects the
 * skill reminder for the agent's next step.
 */
function check(
  agent: Agent,
  state: ObserverState,
  measurement: TokenMeasurement,
  key: string,
  window: number,
  threshold: number,
  ratio: number,
  cycle: number,
): void {
  if (state.fired || measurement.totalTokens < threshold) return
  state.fired = true
  const reason = `${measurement.totalTokens} >= ${threshold} (${ratio} of ${window})`
  agent.session.append('context/handoff', {
    target: key,
    totalTokens: measurement.totalTokens,
    contextWindow: window,
    thresholdTokens: threshold,
    ratio,
    reason,
    cycle,
  })
  const nextCycle = cycle + 1
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: `Context bloat detected (handoff cycle ${cycle}): session pressure ${measurement.totalTokens} tokens reached the `
        + `handoff threshold ${threshold} (${ratio} of ${window} window for ${key}). Load the dsh-context-handoff skill and run `
        + 'its flow: back up the project and conversation, write HANDOFF-<topic>.md, then tell the user to open a fresh '
        + `session. The fresh session must mount this observer and the dsh-observer guard with cycle = ${nextCycle} so the `
        + 'monitoring loop continues.',
    }],
    source: {
      kind: 'plugin',
      plugin: 'context-handoff',
      form: 'notice',
      summary: `context handoff @${threshold}`,
    },
  })
  agent.inject(message)
}
