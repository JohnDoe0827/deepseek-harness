/**
 * CodeWhale-style fleets for DeepSeek Harness: after each turn of an active
 * fleet run, reviewer roles — each with its own provider, model, and
 * reasoning tier — review the task and the agent's latest response through
 * direct LLM calls. A reviewer requesting fixes steers its feedback back into
 * the session so the next step addresses it; when every reviewer passes, the
 * run closes clean. A run closes `fixes-exhausted` after `Config.maxRounds`
 * review rounds, and `/fleet resume` re-runs the reviews for an active run
 * manually.
 *
 * The session log is the run ledger: `fleet/run`, `fleet/review`, and
 * `fleet/end` events are durable, so status, resume, fork, and replay all
 * fold from the log with no live mirror. Roles that omit `provider`/`model`
 * fall back to the session's default route (`ctx.agentDefaultModel`), so a
 * fleet can span vendors in one run or stay on the deployment default.
 *
 * @module @deepseek-ai/dsh-codewhale-fleet
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only edges: resolve ctx.commands and ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-default-model'

export const name = 'codewhale-fleet'
export const inject = ['llm', 'agentDefaultModel']

/** When a role runs its pass: at each turn stop (reviewer) or on the fleet's own clock (observer). */
export type FleetCadence = 'turn-stopping' | 'tick'

/** Runtime guard for the config boundary (JSON/toml input is not type-checked). */
function isFleetCadence(value: unknown): value is FleetCadence {
  return value === 'turn-stopping' || value === 'tick'
}

/** One reviewer role of a fleet: an independent model route plus standing instructions. */
export interface FleetRoleConfig {
  /** Stable role id used in `fleet/review` events and diagnostics. */
  readonly id: string
  /** Human-readable role name shown in status and summaries. */
  readonly label?: string
  /** Standing instructions for this reviewer role. */
  readonly instructions: string
  /** Provider route; defaults to the session's default route when omitted. */
  readonly provider?: string
  /** Model id on the provider; defaults to the session's default route when omitted. */
  readonly model?: string
  /** Reasoning tier for the resolved route; must be supported by the model. */
  readonly reasoningEffort?: string
  /**
   * When this role runs. `turn-stopping` (default) reviews each completed
   * turn. `tick` runs on the fleet's own clock and observes the *live* work:
   * it evaluates deterministic budget rules (turn duration, silence, turn
   * cap, repeated tool calls) before any model call, and records its
   * interventions as `fleet/review` events with `kind: 'observer'`.
   */
  readonly cadence?: FleetCadence
}

/** Deployment-owned fleet configuration. */
export interface Config {
  /** The reviewer roles, in review order. */
  roles: FleetRoleConfig[]
  /**
   * Maximum review rounds per run; a run whose fixes never clear this many
   * reviews closes `fixes-exhausted`.
   */
  maxRounds: number
  /** Byte cap for the assistant transcript sent to a reviewer. */
  maxTranscriptChars: number
  /** Cadence for `tick` roles, in ms (default 1000). */
  tickMs?: number
  /**
   * Maximum wall time one turn may run before a tick observer injects a
   * reminder (level 1). `0` disables.
   */
  maxTurnSeconds?: number
  /** Maximum wall time with no progress before a tick observer steers (level 2). `0` disables. */
  maxSilenceSeconds?: number
  /** Maximum turns before a tick observer cancels the agent (level 3). `0` disables. */
  maxTurns?: number
  /** Consecutive identical tool calls before a tick observer steers (level 2). `0` disables. */
  maxRepeatedToolCalls?: number
}

/** Schemastery configuration for the fleet plugin. */
export const Config: z<Config> = z.object({
  roles: z.array(z.object({
    id: z.string().required(),
    label: z.string(),
    instructions: z.string().required(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
    cadence: z.string(),
  })).required(),
  maxRounds: z.number().required(),
  maxTranscriptChars: z.number().required(),
  tickMs: z.number().default(1000),
  maxTurnSeconds: z.number().default(0),
  maxSilenceSeconds: z.number().default(0),
  maxTurns: z.number().default(0),
  maxRepeatedToolCalls: z.number().default(0),
}) as z<Config>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A fleet run opened: the steered task (if any) follows as a
     * `user/message`. The run id is the run's sequence number as a string.
     */
    'fleet/run': { id: string; roles: number }
    /**
     * One fleet role completed one pass. For a `turn-stopping` reviewer
     * (`kind` absent), `verdict` is the reviewer's structured conclusion and
     * `feedback` its text. For a `tick` observer (`kind: 'observer'`),
     * `verdict` is the deterministic rule outcome (`pass` = no rule tripped,
     * `fix` = a budget rule tripped), `feedback` the delivered reminder, and
     * `chars` the reason text length.
     */
    'fleet/review': {
      id: string
      role: string
      verdict: 'pass' | 'fix'
      feedback: string
      chars: number
      kind?: 'observer'
    }
    /**
     * A fleet run closed: `clean` when every reviewer passed a round,
     * `fixes-exhausted` when `Config.maxRounds` review rounds produced fixes,
     * `observer-triggered` when a tick observer cancelled the agent.
     */
    'fleet/end': { id: string; reason: 'clean' | 'fixes-exhausted' | 'observer-triggered' }
  }
}

/**
 * Validate the deployment config: roles with unique non-empty ids and
 * non-empty instructions, a role naming a model must name a provider and vice
 * versa, a positive integer `maxRounds`, and a positive `maxTranscriptChars`.
 * @param config - raw plugin config.
 * @returns the detached validated config.
 */
export function resolveConfig(config: Config): Config {
  if (!Array.isArray(config.roles) || config.roles.length === 0) {
    throw new Error('FleetConfig `roles` must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const role of config.roles) {
    if (typeof role.id !== 'string' || role.id.trim() === '' || /[^a-z0-9-]/.test(role.id)) {
      throw new Error(`FleetConfig role ids must be non-empty lowercase [a-z0-9-] strings, got ${JSON.stringify(role.id)}`)
    }
    if (seen.has(role.id)) throw new Error(`FleetConfig repeats role id ${JSON.stringify(role.id)}`)
    seen.add(role.id)
    if (typeof role.instructions !== 'string' || role.instructions.trim() === '') {
      throw new Error(`FleetConfig role ${JSON.stringify(role.id)} needs non-empty string instructions`)
    }
    if ((role.provider === undefined) !== (role.model === undefined)) {
      throw new Error(`FleetConfig role ${JSON.stringify(role.id)} must name provider and model together, or neither`)
    }
    if (role.label !== undefined && (typeof role.label !== 'string' || role.label.trim() === '')) {
      throw new Error(`FleetConfig role ${JSON.stringify(role.id)} label must be a non-empty string when set`)
    }
    if (role.cadence !== undefined && !isFleetCadence(role.cadence)) {
      throw new Error(`FleetConfig role ${JSON.stringify(role.id)} cadence must be 'turn-stopping' or 'tick'`)
    }
  }
  if (!Number.isSafeInteger(config.maxRounds) || config.maxRounds <= 0) {
    throw new Error('FleetConfig `maxRounds` must be a positive integer')
  }
  if (typeof config.maxTranscriptChars !== 'number' || !Number.isFinite(config.maxTranscriptChars) || config.maxTranscriptChars <= 0) {
    throw new Error('FleetConfig `maxTranscriptChars` must be a positive number')
  }
  const unknown = Object.keys(config).filter(key => ![
    'roles', 'maxRounds', 'maxTranscriptChars', 'tickMs', 'maxTurnSeconds', 'maxSilenceSeconds', 'maxTurns', 'maxRepeatedToolCalls',
  ].includes(key))
  if (unknown.length > 0) {
    throw new Error(`FleetConfig has unknown key(s) ${unknown.join(', ')}`)
  }
  return config
}

/**
 * The active fleet run in a session log, if any: the latest `fleet/run`
 * whose id has no later `fleet/end`.
 * @param events - the session log or any prefix of it.
 * @returns the active run, or `undefined`.
 */
export function activeFleetRun(events: readonly SessionEvent[]): { id: string; roles: number } | undefined {
  let run: { id: string; roles: number } | undefined
  for (const event of events) {
    if (event.type === 'fleet/run') {
      run = event.data
    } else if (event.type === 'fleet/end' && run?.id === event.data.id) {
      run = undefined
    }
  }
  return run
}

/**
 * How many review passes a run has recorded.
 * @param events - the session log.
 * @param id - the run id.
 * @returns the review count.
 */
export function reviewsForRun(events: readonly SessionEvent[], id: string): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'fleet/review' && event.data.id === id) count++
  }
  return count
}

/**
 * The task text a fleet run steers: the first user-role message after the
 * run event, or the latest user-role message when the run recorded none.
 * @param events - the session log.
 * @param id - the run id.
 * @returns the task text, or an empty string.
 */
export function runTask(events: readonly SessionEvent[], id: string): string {
  let runIndex = -1
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event?.type === 'fleet/run' && event.data.id === id) {
      runIndex = index
      break
    }
  }
  for (let index = runIndex + 1; index < events.length; index++) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') return messageText(event.data)
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') return messageText(event.data)
  }
  return ''
}

/** The text blocks of one message, joined. */
function messageText(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * The assistant's latest response text, capped at `maxChars` code units.
 * @param events - the session log.
 * @param maxChars - the transcript cap.
 * @returns the response text, or an empty string before the first response.
 */
export function latestAssistantText(events: readonly SessionEvent[], maxChars: number): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'assistant/message') {
      const text = messageText(event.data.message)
      return text.slice(0, maxChars)
    }
  }
  return ''
}

/**
 * The next run sequence number for a session: one past its `fleet/run` count.
 * @param events - the session log.
 * @returns the next run number.
 */
export function nextRunNumber(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) {
    if (event.type === 'fleet/run') count++
  }
  return count + 1
}

/**
 * Parse a reviewer's structured verdict out of its raw output: the first
 * JSON object wins; anything else (or a missing `pass` verdict) counts as a
 * fix request carrying the raw text, so an unparseable review can never
 * masquerade as a pass.
 * @param text - the reviewer's raw output.
 * @returns the parsed verdict and feedback.
 */
export function parseReview(text: string): { verdict: 'pass' | 'fix'; feedback: string } {
  const match = /\{[\s\S]*\}/.exec(text)
  if (match !== null) {
    try {
      const parsed: unknown = JSON.parse(match[0])
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const feedback = typeof record.feedback === 'string' ? record.feedback : ''
        if (record.verdict === 'pass') return { verdict: 'pass', feedback }
        return { verdict: 'fix', feedback: feedback.trim() === '' ? '(no feedback provided)' : feedback }
      }
    } catch {
      // The reviewer's JSON is model output, not a contract; the fallback
      // below keeps the raw text as feedback.
    }
  }
  return { verdict: 'fix', feedback: text.trim() === '' ? '(no feedback provided)' : text }
}

/** The tick-observable rule that fired; one per notice. */
type ObserverRuleId = 'turn-budget' | 'silence-budget' | 'turn-cap' | 'repeated-tool'

/** Per-session state the fleet-owned tick observer derives from the durable log. */
interface ObserverSessionState {
  activeTurn: number | undefined
  activeTurnStartedAt: number | undefined
  lastProgressAt: number
  turnCount: number
  repeatKey: string | undefined
  repeatCount: number
  fired: Set<ObserverRuleId>
  cancelledOnce: boolean
}

/** True if this durable event is evidence of progress (fleet/observer bookkeeping is not). */
function isProgressEvent(event: SessionEvent): boolean {
  switch (event.type) {
    case 'todo/write':
    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
      return false
    case 'user/message':
      // A plugin-injected message (a fleet steer or observer reminder) is not
      // the worker making progress; only a direct user prompt counts.
      return event.data.source.kind !== 'plugin'
    default:
      return true
  }
}

/** Canonical identity of one tool-call execution for the repeat chain (deep-sorted args). */
function canonicalToolKey(name: string, argumentsValue: unknown): string {
  return JSON.stringify([name, sortJsonValue(argumentsValue)])
}

/** Deep key-sort a parsed-JSON value so property order does not break the chain key. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** Parse one `tool/call` raw arguments string for the canonical chain; malformed stays as the raw string. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** An observer verdict: `pass` = no rule tripped, `fix` = a budget rule tripped. */
interface ObserverVerdict {
  role: string
  rule: ObserverRuleId
  reason: string
  feedback: string
  level: 1 | 2 | 3
}

/**
 * Evaluate the deterministic tick-observer rules against one session's
 * observed state. Returns the strongest tripped rule, else `undefined`.
 */
function evaluateObserver(
  state: ObserverSessionState,
  cfg: Config,
  now: number,
  runId: string,
  roles: FleetRoleConfig[],
): ObserverVerdict | undefined {
  const enabled = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0
  const role = roles[0]
  if (role === undefined) return undefined

  const candidates: ObserverVerdict[] = []
  const turn = state.activeTurn
  const turnStart = state.activeTurnStartedAt

  if (
    turn !== undefined && turnStart !== undefined
    && !state.fired.has('turn-budget') && enabled(cfg.maxTurnSeconds)
    && now - turnStart > cfg.maxTurnSeconds * 1000
  ) {
    candidates.push({
      role: role.id,
      rule: 'turn-budget',
      level: 1,
      reason: `turn ${turn} ran ${Math.round((now - turnStart) / 1000)}s (budget ${cfg.maxTurnSeconds}s)`,
      feedback: `Fleet observer: turn ${turn} exceeded the ${cfg.maxTurnSeconds}s budget. If blocked, say so explicitly or change approach.`,
    })
  }

  if (
    !state.fired.has('silence-budget') && enabled(cfg.maxSilenceSeconds)
    && now - state.lastProgressAt > cfg.maxSilenceSeconds * 1000 && state.turnCount > 0
  ) {
    const silent = Math.round((now - state.lastProgressAt) / 1000)
    candidates.push({
      role: role.id,
      rule: 'silence-budget',
      level: 2,
      reason: `no progress for ${silent}s (budget ${cfg.maxSilenceSeconds}s)`,
      feedback: `Fleet observer: no progress for ${silent}s. Report concrete next steps or the blocking condition.`,
    })
  }

  if (!state.fired.has('turn-cap') && enabled(cfg.maxTurns) && state.turnCount >= cfg.maxTurns) {
    candidates.push({
      role: role.id,
      rule: 'turn-cap',
      level: 3,
      reason: `session reached ${cfg.maxTurns} turns`,
      feedback: `Fleet observer: session reached the ${cfg.maxTurns}-turn cap; stopping run ${runId}.`,
    })
  }

  if (
    !state.fired.has('repeated-tool') && enabled(cfg.maxRepeatedToolCalls)
    && state.repeatCount >= cfg.maxRepeatedToolCalls
  ) {
    candidates.push({
      role: role.id,
      rule: 'repeated-tool',
      level: 2,
      reason: `same tool call repeated ${state.repeatCount}×`,
      feedback: `Fleet observer: the identical tool call repeated ${state.repeatCount}×. Choose a different action or change approach.`,
    })
  }

  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.level - a.level)
  return candidates[0]
}

/**
 * Deliver one observer verdict: record the durable `fleet/review` event and
 * intervene at the verdict's strength — level 1 inject (remind), level 2
 * steer (redirect), level 3 cancel + `fleet/end` (`observer-triggered`).
 */
function observerIntervene(
  session: Session,
  agent: Agent,
  state: ObserverSessionState,
  verdict: ObserverVerdict,
): void {
  state.fired.add(verdict.rule)
  session.append('fleet/review', {
    id: activeFleetRun(session.events)?.id ?? '',
    role: verdict.role,
    // Any tripped rule is a `fix` verdict: the observer asked the worker to
    // change approach. `pass` is reserved for an evaluation where no rule
    // tripped (which this function never receives).
    verdict: 'fix',
    feedback: verdict.feedback,
    chars: verdict.reason.length,
    kind: 'observer',
  })
  const message = createUserMessage({
    content: [{ type: 'text', text: verdict.feedback }],
    source: {
      kind: 'plugin',
      plugin: 'codewhale-fleet',
      form: 'notice',
      summary: `Fleet observer ${verdict.rule} @${verdict.level}`,
    },
  })
  if (verdict.level === 3) {
    if (!state.cancelledOnce) {
      state.cancelledOnce = true
      agent.cancel({ kind: 'hook', reason: `observer ${verdict.rule}: ${verdict.reason}` })
    }
    // The cancellation is announced before the worker converges; the run ends
    // observer-triggered so status/resume reflect the observer's decision.
    const run = activeFleetRun(session.events)
    if (run !== undefined) session.append('fleet/end', { id: run.id, reason: 'observer-triggered' })
  } else if (verdict.level === 2) {
    if (!state.cancelledOnce) {
      state.cancelledOnce = true
      agent.steer(message)
    }
  } else {
    agent.inject(message)
  }
}

/**
 * Register the fleet plugin: the `agent/turn-stopping` review hook and the
 * `/fleet` command.
 * @param ctx - registrant context carrying the llm and agent-default-model services.
 * @param config - deployment-owned fleet configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = resolveConfig(config)
  // The step each session last reviewed, so one stop boundary cannot review
  // twice while a steered fix re-opens the same turn. Weak keys: disposed
  // sessions drop their tracking automatically.
  const lastReviewedStep = new WeakMap<Session, number>()
  // Per-session tick-observer state (fleet-owned clock facts).
  const observerState = new WeakMap<Session, ObserverSessionState>()
  const observedSessions = new Set<Session>()
  const tickRoles = cfg.roles.filter(role => role.cadence === 'tick')

  function observerFor(session: Session): ObserverSessionState {
    let state = observerState.get(session)
    if (state === undefined) {
      state = {
        activeTurn: undefined,
        activeTurnStartedAt: undefined,
        lastProgressAt: Date.now(),
        turnCount: 0,
        repeatKey: undefined,
        repeatCount: 0,
        fired: new Set(),
        cancelledOnce: false,
      }
      observerState.set(session, state)
      observedSessions.add(session)
    }
    return state
  }

  /** The resolved LLM route for one role: its own route, else the session default. */
  function routeFor(role: FleetRoleConfig): LlmCallConfig {
    const fallback = ctx.agentDefaultModel.currentSelection()
    const reasoningEffort = role.reasoningEffort !== undefined
      ? ReasoningEffortId(role.reasoningEffort)
      : fallback.reasoningEffort
    return {
      provider: role.provider ?? fallback.provider,
      model: role.model ?? fallback.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
  }

  /**
   * Run one review round for the active fleet run of an agent's session:
   * each reviewer role passes over the task and the latest response, a fix
   * verdict steers its feedback back into the session, and a clean round
   * closes the run.
   * @param agent - the agent whose turn is stopping.
   * @param step - the step that just ended.
   * @param signal - the turn's cancellation signal.
   */
  async function reviewTurn(agent: Agent, step: number, signal: AbortSignal): Promise<void> {
    const session = agent.session
    const run = activeFleetRun(session.events)
    if (run === undefined || signal.aborted) return
    if (reviewsForRun(session.events, run.id) >= cfg.maxRounds) {
      session.append('fleet/end', { id: run.id, reason: 'fixes-exhausted' })
      return
    }
    lastReviewedStep.set(session, step)
    const task = runTask(session.events, run.id)
    const transcript = latestAssistantText(session.events, cfg.maxTranscriptChars)
    let firstFix: { role: FleetRoleConfig; feedback: string } | undefined
    for (const role of cfg.roles) {
      // Tick observers evaluate on their own clock, not at the turn boundary.
      if (role.cadence === 'tick') continue
      // Cancellation during the reviewer call is handled inside reviewWith
      // (prepareCall and the chunk loop honor the signal).
      const outcome = await reviewWith(role, task, transcript, signal)
      session.append('fleet/review', {
        id: run.id,
        role: role.id,
        verdict: outcome.verdict,
        feedback: outcome.feedback,
        chars: outcome.chars,
      })
      if (outcome.verdict === 'fix' && firstFix === undefined) {
        firstFix = { role, feedback: outcome.feedback }
      }
    }
    if (firstFix !== undefined) {
      const { role, feedback } = firstFix
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: feedback }],
        source: {
          kind: 'plugin',
          plugin: 'codewhale-fleet',
          form: 'notice',
          summary: `Fleet review by ${role.label ?? role.id}: fixes requested`,
        },
      }))
    } else {
      session.append('fleet/end', { id: run.id, reason: 'clean' })
    }
  }

  /**
   * One reviewer pass: a direct LLM call on the role's route whose output is
   * parsed into a structured verdict.
   */
  async function reviewWith(
    role: FleetRoleConfig,
    task: string,
    transcript: string,
    signal: AbortSignal,
  ): Promise<{ verdict: 'pass' | 'fix'; feedback: string; chars: number }> {
    const route = routeFor(role)
    const prepared = await ctx.llm.prepareCall(route, signal)
    const system = `You are the "${role.label ?? role.id}" reviewer role in a multi-model coding fleet.\n${role.instructions}`
    const user = [
      'Task:',
      task,
      '',
      'Agent response to review:',
      transcript,
      '',
      'Reply with ONLY a JSON object: {"verdict": "pass" | "fix", "feedback": "..."}',
    ].join('\n')
    const stream = prepared.stream({
      ...route,
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } })],
      system,
      signal,
    })
    let text = ''
    for await (const chunk of stream) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta') text += chunk.text
    }
    const parsed = parseReview(text)
    return { verdict: parsed.verdict, feedback: parsed.feedback, chars: text.length }
  }

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (signal.aborted) return
    const step = latestStep(agent.session.events)
    if (step === undefined || lastReviewedStep.get(agent.session) === step) return
    await reviewTurn(agent, step, signal)
  })

  // ---- tick observer: fleet-owned clock over live worker facts ----
  // Fact stream: durable session events update per-session observer state.
  ctx.effect(function* () {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      const state = observerFor(session)
      switch (event.type) {
        case 'turn/start':
          state.activeTurn = event.data.turn
          state.activeTurnStartedAt = Date.now()
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
          if (isProgressEvent(event)) state.lastProgressAt = Date.now()
          return
      }
    })
    ctx.on('agent/created', ({ agent }) => { observerFor(agent.session) })
    ctx.on('agent/disposed', ({ agent }) => {
      observedSessions.delete(agent.session)
      observerState.delete(agent.session)
    })

    if (tickRoles.length > 0) {
      // The agents registry is optional and may mount after this plugin. Read
      // it lazily each tick so a loop composed later is still observed.
      const timer = setInterval(() => {
        const agents = ctx.get('agents')
        const now = Date.now()
        for (const session of Array.from(observedSessions)) {
          const agent = agents?.get(session.id)
          if (agent === undefined || agent.session !== session) continue
          const state = observerState.get(session)
          if (state === undefined || state.cancelledOnce) continue
          const run = activeFleetRun(session.events)
          if (run === undefined) continue
          const verdict = evaluateObserver(state, cfg, now, run.id, tickRoles)
          if (verdict === undefined) continue
          observerIntervene(session, agent, state, verdict)
        }
      }, Math.max(10, cfg.tickMs ?? 1000))
      yield () => { clearInterval(timer) }
    }
  })

  // The command child activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'fleet',
      description: 'Run, resume, or inspect a multi-model fleet review',
      input: { hint: '[run [task] | resume | status]' },
      handler: async ({ agent, rawInput, signal }) => {
        const args = rawInput.trim()
        if (args === '' || args === 'status') {
          return { kind: 'success', text: fleetStatus(agent.session.events) }
        }
        if (args === 'run' || args.startsWith('run ')) {
          const id = String(nextRunNumber(agent.session.events))
          agent.session.append('fleet/run', { id, roles: cfg.roles.length })
          const task = args.length > 4 ? args.slice(4).trim() : ''
          if (task !== '') {
            agent.steer(createUserMessage({
              content: [{ type: 'text', text: task }],
              source: { kind: 'user' },
            }))
          }
          return {
            kind: 'success',
            text: task === ''
              ? `Fleet run ${id} started (${cfg.roles.length} reviewer roles); reviews run after each turn.`
              : `Fleet run ${id} started (${cfg.roles.length} reviewer roles) with task "${task}".`,
          }
        }
        if (args === 'resume') {
          const run = activeFleetRun(agent.session.events)
          if (run === undefined) {
            return { kind: 'error', text: 'No active fleet run to resume; start one with /fleet run [task].' }
          }
          const step = latestStep(agent.session.events)
          if (step === undefined) {
            return { kind: 'error', text: 'No completed step to review yet; send the agent a task first.' }
          }
          await reviewTurn(agent, step, signal)
          const ended = agent.session.events.some(event => event.type === 'fleet/end' && event.data.id === run.id)
          return {
            kind: 'success',
            text: ended
              ? `Fleet run ${run.id} reviews completed; the run closed.`
              : `Fleet run ${run.id} reviews completed; fixes were steered back to the agent.`,
          }
        }
        return { kind: 'error', text: 'Usage: /fleet [run [task] | resume | status]' }
      },
    })
  })
}

/** The latest completed step number in a session log, if any. */
function latestStep(events: readonly SessionEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'step/end') return event.data.step
  }
  return undefined
}

/** A compact status rendering of every fleet run in a session log. */
function fleetStatus(events: readonly SessionEvent[]): string {
  const lines: string[] = []
  const runs = new Map<string, { roles: number; reviews: string[]; end?: string }>()
  for (const event of events) {
    if (event.type === 'fleet/run') {
      runs.set(event.data.id, { roles: event.data.roles, reviews: [] })
    } else if (event.type === 'fleet/review') {
      const run = runs.get(event.data.id)
      run?.reviews.push(`${event.data.role}: ${event.data.verdict}${event.data.chars > 0 ? ` (${event.data.chars} chars)` : ''}`)
    } else if (event.type === 'fleet/end') {
      const run = runs.get(event.data.id)
      if (run !== undefined) run.end = event.data.reason
    }
  }
  if (runs.size === 0) return 'No fleet runs in this session.'
  for (const [id, run] of runs) {
    const status = run.end === undefined ? 'active' : `ended: ${run.end}`
    lines.push(`Run ${id}: ${run.roles} reviewer roles, ${status}`)
    for (const review of run.reviews) lines.push(`  ${review}`)
  }
  return lines.join('\n')
}
