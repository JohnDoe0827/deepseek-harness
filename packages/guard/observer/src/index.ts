/**
 * Timeline-independent agent observer.
 *
 * The observer runs on its own clock and its own fact stream, independent of
 * the agent's turn/step timeline: it consumes the durable session event
 * broadcast (`session/event`), live agent lifecycle events (`agent/*`), and
 * tool executions (`tools/*`), and evaluates user-configured rules — turn
 * budget, silence (no-progress) budget, overall turn cap, and repeated tool
 * calls — against those facts. When a rule fires it intervenes at escalating
 * strength, decided from observed facts only, never from the agent's own
 * claims:
 *
 * 1. `agent.inject()` — queue a model-visible reminder for the next step
 *    (weak; does not stop the current work);
 * 2. `agent.steer()` — redirect the turn with concrete feedback (medium;
 *    the agent answers it like a user interjection);
 * 3. `agent.cancel({ kind: 'hook', reason })` — stop the agent (strong; the
 *    durable `turn/end` records the observer's cause).
 *
 * Every intervention appends an `observer/notice` session event so the log
 * reconstructs what the observer did (model-visible means logged — the
 * injected/steered text is not the only record; the notice names rule, level,
 * and reason).
 *
 * The unit of observation is one session. The observer never drives the
 * agent; it only reads facts and, when a rule fires, submits intervention
 * requests through the same inbox boundaries a user would use.
 *
 * @module @deepseek-ai/dsh-observer
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'observer'
export const inject = ['agents']

/** Escalating intervention levels; a higher number is a stronger action. */
export type ObserverInterventionLevel = 1 | 2 | 3

/** The rule that fired; one per notice, stable ids for diagnostics. */
export type ObserverRuleId = 'turn-budget' | 'silence-budget' | 'turn-cap' | 'repeated-tool'

/** Durable payload of one `observer/notice` event. */
export interface ObserverNoticeData {
  rule: ObserverRuleId
  level: ObserverInterventionLevel
  reason: string
  text: string
}

/** Deployment-owned observer configuration: the immutable rules to enforce. */
export interface Config {
  /** Evaluate rules on this cadence, in ms (default 1000). */
  tickMs?: number
  /** Maximum wall time one turn may run before the observer injects a reminder (default 300_000). */
  maxTurnSeconds?: number
  /** Maximum wall time with no progress events before steering (default 120_000). */
  maxSilenceSeconds?: number
  /** Maximum total turns per session before the observer cancels (default 50). */
  maxTurns?: number
  /** Consecutive identical tool calls (same name+args) that trigger steering (default 3, like the repeat guard). */
  maxRepeatedToolCalls?: number
  /** Always inject the observer's standing-pattern reminders even when no rule fired yet. */
  enableStandingReminder?: boolean
}

export const Config: z<Config> = z.object({
  tickMs: z.number().default(1000),
  maxTurnSeconds: z.number().default(300),
  maxSilenceSeconds: z.number().default(120),
  maxTurns: z.number().default(50),
  maxRepeatedToolCalls: z.number().default(3),
  enableStandingReminder: z.boolean().default(false),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One observer intervention. `rule` names the fired rule, `level` the
     * escalated strength (1 inject / 2 steer / 3 cancel), `reason` the
     * observed facts that fired it, and `text` the message actually delivered
     * to the agent (inject or steer content; empty for a cancel).
     * @mode durable, model-visible adjacency: the delivered text must be
     * reconstructable from this event.
     */
    'observer/notice': ObserverNoticeData
  }
}

/** Per-session observation state, keyed live (disposed sessions drop it). */
interface ObserverState {
  /** Turn currently in flight, if any: its number and the time the loop entered it. */
  activeTurn: number | undefined
  activeTurnStartedAt: number | undefined
  /** Monotonic wall time of the last progress event (any non-noise event). */
  lastProgressAt: number
  /** Total turns opened since observation began. */
  turnCount: number
  /** Consecutive identical tool-call chain: canonical key and run length. */
  repeatKey: string | undefined
  repeatCount: number
  /** Rules already fired for the current active turn, keyed by rule id, to avoid re-firing within one turn. */
  fired: Set<ObserverRuleId>
  /** Whether this session is currently stopped by the observer (notice sent). */
  cancelledOnce: boolean
}

const PLUGIN_SOURCE = { kind: 'plugin' as const, plugin: 'observer' }

/** Canonical identity of one tool-call execution for the repeat chain (name + deep-sorted args). */
function canonicalToolKey(name: string, argumentsValue: unknown): string {
  return JSON.stringify([name, sortValue(argumentsValue)])
}

/** Deep key-sort a parsed-JSON value so property order does not break the chain key. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key])
    return sorted
  }
  return value
}

/** True if this durable event is evidence of progress (observer injections and bookkeeping noise are not). */
function isProgressEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case 'todo/write':
    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
      return false
    case 'user/message':
      // A plugin-injected message (the observer's own reminder or any other
      // synthetic context) is not the agent making progress; only a direct
      // user prompt counts.
      return event.data.source.kind !== 'plugin'
    default:
      return true
  }
}

/**
 * One observer intervention: deliver the message and append the durable
 * notice. `level === 3` cancels after appending so the log orders the cause
 * before the turn end.
 */
function intervene(
  state: ObserverState,
  agent: Agent,
  level: ObserverInterventionLevel,
  rule: ObserverRuleId,
  reason: string,
  text: string,
): void {
  state.fired.add(rule)
  const message: UserMessage = createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice' as const,
      summary: `observer ${rule} @${level}`,
    },
  })
  agent.session.append('observer/notice', { rule, level, reason, text })
  if (level >= 2) {
    if (!state.cancelledOnce) {
      state.cancelledOnce = true
      // Steering reaches the nearest step like a user interjection.
      agent.steer(message)
    }
    if (level === 3) {
      agent.cancel({ kind: 'hook', reason: `observer ${rule}: ${reason}` })
    }
  } else {
    // Level 1: queue context for the next step without waking the driver.
    agent.inject(message)
  }
}

/**
 * Evaluate every rule for one session against its observed state. Returns the
 * strongest intervention needed, if any.
 * @returns `{ level, rule, reason, text }` when a rule fires, else `undefined`.
 */
function evaluate(
  state: ObserverState,
  cfg: Config,
  now: number,
): { level: ObserverInterventionLevel; rule: ObserverRuleId; reason: string; text: string } | undefined {
  const turn = state.activeTurn
  const turnStart = state.activeTurnStartedAt

  // A rule is enabled only by a finite positive value; `0`, a negative, or
  // `NaN` disables it (never "fire immediately").
  const enabled = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0

  const candidates: { level: ObserverInterventionLevel; rule: ObserverRuleId; reason: string; text: string }[] = []

  if (
    turn !== undefined && turnStart !== undefined
    && !state.fired.has('turn-budget')
    && enabled(cfg.maxTurnSeconds)
    && now - turnStart > cfg.maxTurnSeconds * 1000
  ) {
    candidates.push({
      level: 1,
      rule: 'turn-budget',
      reason: `turn ${turn} has run ${Math.round((now - turnStart) / 1000)}s (budget ${cfg.maxTurnSeconds}s)`,
      text: `Observer: turn ${turn} has exceeded the ${cfg.maxTurnSeconds}s budget. If you are blocked, say so explicitly or change approach instead of continuing silently.`,
    })
  }

  if (
    !state.fired.has('silence-budget')
    && enabled(cfg.maxSilenceSeconds)
    && now - state.lastProgressAt > cfg.maxSilenceSeconds * 1000
    && state.turnCount > 0
  ) {
    const silent = Math.round((now - state.lastProgressAt) / 1000)
    candidates.push({
      level: 2,
      rule: 'silence-budget',
      reason: `no progress events for ${silent}s (budget ${cfg.maxSilenceSeconds}s)`,
      text: `Observer: no progress observed for ${silent}s. Report concrete next steps or the blocking condition; do not continue silently.`,
    })
  }

  if (
    !state.fired.has('turn-cap')
    && enabled(cfg.maxTurns)
    && state.turnCount >= cfg.maxTurns
  ) {
    candidates.push({
      level: 3,
      rule: 'turn-cap',
      reason: `session reached ${cfg.maxTurns} turns`,
      text: `Observer: session reached the ${cfg.maxTurns}-turn cap; stopping.`,
    })
  }

  if (
    !state.fired.has('repeated-tool')
    && enabled(cfg.maxRepeatedToolCalls)
    && state.repeatCount >= cfg.maxRepeatedToolCalls
  ) {
    candidates.push({
      level: 2,
      rule: 'repeated-tool',
      reason: `same tool call repeated ${state.repeatCount}×`,
      text: `Observer: the identical tool call has repeated ${state.repeatCount}×. Inspect the latest result; choose a different action, different arguments, or finish the task.`,
    })
  }

  // Deliver the strongest rule this tick; weaker ones stay eligible until
  // their own budget runs longer.
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.level - a.level)
  return candidates[0]
}

/**
 * Install the observer: the independent tick, the fact-stream listeners, and
 * the intervention surface. All registrations are effects scoped to this
 * plugin's context and unwind with it.
 * @param ctx - registrant context.
 * @param config - validated observer rules.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = config
  const states = new WeakMap<Session, ObserverState>()
  const sessions = new Set<Session>()
  const now = () => Date.now()

  function stateFor(session: Session): ObserverState {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        activeTurn: undefined,
        activeTurnStartedAt: undefined,
        lastProgressAt: now(),
        turnCount: 0,
        repeatKey: undefined,
        repeatCount: 0,
        fired: new Set(),
        cancelledOnce: false,
      }
      states.set(session, state)
      sessions.add(session)
    }
    return state
  }

  ctx.effect(function* () {
    // ---- fact stream: durable session events ----
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const state = stateFor(session)
      switch (event.type) {
        case 'turn/start':
          state.activeTurn = event.data.turn
          state.activeTurnStartedAt = now()
          state.turnCount += 1
          state.fired.clear()
          return
        case 'turn/end':
          state.activeTurn = undefined
          state.activeTurnStartedAt = undefined
          return
        case 'tool/call': {
          const key = canonicalToolKey(event.data.name, safeParse(event.data.arguments))
          state.repeatCount = state.repeatKey === key ? state.repeatCount + 1 : 1
          state.repeatKey = key
          return
        }
        default:
          if (isProgressEvent(event)) state.lastProgressAt = now()
          return
      }
    })

    // ---- fact stream: live agent lifecycle ----
    ctx.on('agent/created', ({ agent }) => { stateFor(agent.session) })
    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent.session) })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') {
        const state = states.get(agent.session)
        if (state !== undefined) state.lastProgressAt = now()
      }
    })

    // ---- intervention surface: pure observe; the repeat chain advanced on
    // tool/call. No tools/* listener is needed because the chain is derived
    // from the durable `tool/call` event, not the live execution.

    // ---- independent tick: the observer's own clock ----
    const timer = setInterval(() => {
      for (const session of Array.from(sessions)) {
        const agent = ctx.agents.get(session.id)
        if (agent === undefined || agent.session !== session) continue
        const state = states.get(session)
        // Evaluate always: turn-budget/silence only bite during an active
        // turn (they guard on activeTurn), while turn-cap must fire at the
        // turn boundary too, not only mid-turn.
        if (state === undefined || state.cancelledOnce) continue
        const verdict = evaluate(state, cfg, now())
        if (verdict !== undefined) {
          intervene(state, agent, verdict.level, verdict.rule, verdict.reason, verdict.text)
        }
      }
    }, Math.max(10, cfg.tickMs ?? 1000))

    yield () => { clearInterval(timer) }
  })
}

/** Parse one `tool/call` raw arguments string for the canonical chain; malformed stays as the raw string. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
