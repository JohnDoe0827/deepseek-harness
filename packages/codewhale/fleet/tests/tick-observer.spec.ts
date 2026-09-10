/**
 * Tick-observer coverage for @deepseek-ai/dsh-codewhale-fleet: a role with
 * `cadence: 'tick'` observes the LIVE worker on the fleet's own clock (fake
 * timers, deterministic) and intervenes at three levels, recording durable
 * `fleet/review` events with `kind: 'observer'` and, on a level-3 cancel,
 * a `fleet/end reason: 'observer-triggered'`. Uses a real agent loop so the
 * observer can resolve the live agent through the registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, LlmAdapter, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Fleet from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** A tick-observer-only fleet config with small budgets for fake-timer tests. */
const baseConfig: Config = {
  roles: [{ id: 'observer', cadence: 'tick', instructions: 'Watch for stalls and loops.' }],
  maxRounds: 2,
  maxTranscriptChars: 8000,
  tickMs: 50,
  maxTurnSeconds: 1,
  maxSilenceSeconds: 1,
  maxTurns: 2,
  maxRepeatedToolCalls: 2,
}

/** A model script that hangs until aborted, emitting NO progress chunks. */
function silentHang(_options: GenerateOptions): AsyncIterable<StreamChunk> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      const signal = _options.signal
      if (signal?.aborted) { resolve(); return }
      signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })()
}

class HangAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for await (const chunk of silentHang(options)) yield chunk
  }
}

/** One-pass adapter that returns a clean review verdict. */
class ScriptedPassAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '{"verdict":"pass","feedback":""}'
    for (let index = 0; index < text.length; index += 8) {
      yield { type: 'text-delta', index: 0, text: text.slice(index, index + 8) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Scripted adapter returning a fix verdict on demand, pass otherwise. */
class ScriptedJudgeAdapter extends LlmAdapter {
  private call = 0
  constructor(private readonly verdicts: ('pass' | 'fix')[]) { super() }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const verdict = this.verdicts[this.call] ?? 'pass'
    this.call++
    const text = `{"verdict":"${verdict}","feedback":"judge says ${verdict}"}`
    for (let index = 0; index < text.length; index += 8) {
      yield { type: 'text-delta', index: 0, text: text.slice(index, index + 8) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await Promise.allSettled([ctx.fiber.dispose()])
  }
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

/**
 * Mount the fleet plugin directly (apply is a plain function with a config
 * argument; loader schema delegation is covered by loader-composition.spec,
 * so tick tests call apply directly for a deterministic clock) beside a real
 * loop and agent.
 */
async function harness(
  cfg: Config = baseConfig,
  adapter: LlmAdapter = new HangAdapter(),
  judgeAdapter?: LlmAdapter,
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
  Fleet.apply(ctx, cfg)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (judgeAdapter !== undefined) ctx.llm.registerAdapter(['judge'], judgeAdapter)
  const agent = ctx.agentLoop.create(SessionId(`fleet-tick-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, agent }
}

/** Narrowed `fleet/review` events with `kind: 'observer'`. */
function observerReviews(agent: Agent): Extract<SessionEvent, { type: 'fleet/review' }>[] {
  return agent.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'fleet/review' }> =>
      event.type === 'fleet/review' && event.data.kind === 'observer',
  )
}

/** The text of every plugin-sourced user message on a session (inject/steer delivery). */
function pluginDelivered(agent: Agent, needle: string): boolean {
  return agent.session.events.some(event =>
    event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && JSON.stringify(event.data.content).includes(needle))
}

describe('fleet tick observer', () => {
  it('opens a run, then injects (level 1) when a live turn passes the turn budget', async () => {
    // Explicit config: silence rule disabled so only turn-budget fires.
    const cfg: Config = {
      roles: [{ id: 'observer', cadence: 'tick', instructions: 'Watch for stalls and loops.' }],
      maxRounds: 2,
      maxTranscriptChars: 8000,
      tickMs: 50,
      maxTurnSeconds: 1,
      maxSilenceSeconds: 0,
      maxTurns: 2,
      maxRepeatedToolCalls: 2,
    }
    const { agent } = await harness(cfg)
    agent.session.append('fleet/run', { id: '1', roles: 1 })
    agent.session.append('turn/start', { turn: 1 })

    // Run past maxTurnSeconds (1s) on the fake clock.
    await vi.advanceTimersByTimeAsync(1500)

    const reviews = observerReviews(agent)
    expect(reviews.length).toBeGreaterThanOrEqual(1)
    expect(reviews[0]?.data).toMatchObject({ id: '1', role: 'observer', verdict: 'fix', kind: 'observer' })
    // The durable record carries the reminder text (level 1 inject queues for
    // the next pre-step; the notice is the immediate reconstructable account).
    expect(reviews[0]?.data.feedback).toContain('budget')

    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('steers (level 2) when identical tool calls repeat past the threshold', async () => {
    const { agent } = await harness()
    agent.session.append('fleet/run', { id: '1', roles: 1 })
    agent.session.append('turn/start', { turn: 1 })
    for (let index = 0; index < 3; index++) {
      agent.session.append('tool/call', {
        turn: 1, step: 1, callId: CallId(`c${index}`), name: 'bash', arguments: '{"command":"ls"}',
      })
    }
    await vi.advanceTimersByTimeAsync(500)

    const reviews = observerReviews(agent)
    expect(reviews[0]?.data.verdict).toBe('fix')
    expect(pluginDelivered(agent, 'identical tool call')).toBe(true)

    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('cancels the agent and closes the run observer-triggered at the turn cap', async () => {
    const { agent } = await harness()
    agent.session.append('fleet/run', { id: '1', roles: 1 })

    // Advance 3 turns (maxTurns=2); the cap fires on the third turn boundary.
    for (let turn = 1; turn <= 3; turn++) {
      agent.session.append('turn/start', { turn })
      agent.session.append('step/start', { turn, step: 1 })
      agent.session.append('assistant/message', {
        turn, step: 1, message: {
          id: MessageId(`assistant-${turn}`), role: 'assistant', content: [{ type: 'text', text: `turn ${turn}` }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      }, { surfaceOp: 'append' })
      agent.session.append('step/end', { turn, step: 1 })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      await vi.advanceTimersByTimeAsync(200)
    }

    const reviews = observerReviews(agent)
    const ends = agent.session.events.filter(event => event.type === 'fleet/end')
    // The cap's level-3 cancel closed the run observer-triggered.
    expect(reviews.filter(r => r.data.verdict === 'fix').length).toBeGreaterThanOrEqual(1)
    expect(ends.some(event => event.data.id === '1' && event.data.reason === 'observer-triggered')).toBe(true)
  }, 30_000)

  it('recorded observer reviews are reconstructable from the log alone (no live mirror)', async () => {
    const { agent } = await harness()
    agent.session.append('fleet/run', { id: '1', roles: 1 })
    agent.session.append('turn/start', { turn: 1 })
    await vi.advanceTimersByTimeAsync(1500)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const events = agent.session.events
    const runAtIndex = events.findIndex(event => event.type === 'fleet/run' && event.data.id === '1')
    const reviewAtIndex = events.findIndex(event => event.type === 'fleet/review' && event.data.kind === 'observer')
    expect(runAtIndex).toBeGreaterThanOrEqual(0)
    expect(reviewAtIndex).toBeGreaterThan(runAtIndex)
  })

  it('coexists with a turn-stopping reviewer: reviewer at stop, observer on the clock', async () => {
    // One reviewer + one tick observer.
    const cfg: Config = {
      roles: [
        { id: 'reviewer', instructions: 'Review the response.' },
        { id: 'observer', cadence: 'tick', instructions: 'Watch for loops.' },
      ],
      maxRounds: 2,
      maxTranscriptChars: 8000,
      tickMs: 50,
      maxTurnSeconds: 1,
      maxSilenceSeconds: 0,
      maxTurns: 2,
      maxRepeatedToolCalls: 0,
    }
    const { ctx, agent } = await harness(cfg, new ScriptedPassAdapter())

    agent.session.append('fleet/run', { id: '1', roles: 2 })
    // A completed step triggers the turn-stopping reviewer.
    agent.session.append('step/end', { turn: 1, step: 1 })
    await ctx.serial('agent/turn-stopping', {
      agent, turn: 1, signal: new AbortController().signal,
    } as never)
    await vi.advanceTimersByTimeAsync(50)

    const reviews = agent.session.events.filter((event): event is Extract<SessionEvent, { type: 'fleet/review' }> =>
      event.type === 'fleet/review')
    // The turn-stopping reviewer recorded a pass without the observer kind.
    expect(reviews.some(r => r.data.role === 'reviewer' && r.data.kind === undefined)).toBe(true)
    // The tick observer saw a clean idle run and recorded nothing (no rule tripped).
    expect(reviews.filter(r => r.data.kind === 'observer')).toHaveLength(0)
  }, 30_000)

  it('LLM judge pass: records an observer review without steering (no rule tripped)', async () => {
    // A judging tick role with its own route; all budget rules disabled so
    // ONLY the judge speaks.
    const cfg: Config = {
      roles: [
        { id: 'judge', cadence: 'tick', judge: true, provider: 'judge', model: 'judge', instructions: 'Judge live progress.' },
      ],
      maxRounds: 2,
      maxTranscriptChars: 8000,
      tickMs: 50,
      maxTurnSeconds: 0,
      maxSilenceSeconds: 0,
      maxTurns: 0,
      maxRepeatedToolCalls: 0,
      judgeIntervalMs: 50,
      judgeTranscriptChars: 8000,
    }
    const { agent } = await harness(cfg, new HangAdapter(), new ScriptedJudgeAdapter(['pass', 'pass']))
    agent.session.append('fleet/run', { id: '1', roles: 1 })
    // A fleet run steers its task as a user message; the judge needs it.
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'build the widget' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1, step: 1, message: {
        id: MessageId('assistant-judged'), role: 'assistant', content: [{ type: 'text', text: 'working on the task' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }, { surfaceOp: 'append' })

    await vi.advanceTimersByTimeAsync(200)

    const reviews = observerReviews(agent)
    expect(reviews.length).toBeGreaterThanOrEqual(1)
    expect(reviews[0]?.data).toMatchObject({ id: '1', role: 'judge', verdict: 'pass', kind: 'observer' })
    // A pass does not steer or close the run.
    expect(agent.session.events.some(event => event.type === 'fleet/end' && event.data.id === '1')).toBe(false)

    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }, 30_000)

  it('LLM judge fix: steers and closes the run observer-triggered', async () => {
    const cfg: Config = {
      roles: [
        { id: 'judge', cadence: 'tick', judge: true, provider: 'judge', model: 'judge', instructions: 'Judge live progress.' },
      ],
      maxRounds: 2,
      maxTranscriptChars: 8000,
      tickMs: 50,
      maxTurnSeconds: 0,
      maxSilenceSeconds: 0,
      maxTurns: 0,
      maxRepeatedToolCalls: 0,
      judgeIntervalMs: 50,
      judgeTranscriptChars: 8000,
    }
    const { agent } = await harness(cfg, new HangAdapter(), new ScriptedJudgeAdapter(['fix', 'pass']))
    agent.session.append('fleet/run', { id: '1', roles: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'build the widget' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1, step: 1, message: {
        id: MessageId('assistant-judged-fix'), role: 'assistant', content: [{ type: 'text', text: 'going the wrong way' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
    }, { surfaceOp: 'append' })

    await vi.advanceTimersByTimeAsync(200)

    const reviews = observerReviews(agent)
    expect(reviews.some(r => r.data.role === 'judge' && r.data.verdict === 'fix')).toBe(true)
    // A fix steers the feedback and closes the run observer-triggered.
    expect(pluginDelivered(agent, 'judge says fix')).toBe(true)
    expect(agent.session.events.some(event =>
      event.type === 'fleet/end' && event.data.id === '1' && event.data.reason === 'observer-triggered')).toBe(true)

    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }, 30_000)
})
