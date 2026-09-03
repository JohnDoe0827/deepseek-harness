/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-observer. The rule
 * firings drive the observer's tick under fake timers (deterministic, no
 * wall-clock race) and assert the durable `observer/notice` events and the
 * hook-sourced cancellation the observer causes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MockAdapter, textResponse, toolCallResponse,
} from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as observer from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Default observer config: fast tick, small budgets. */
function defaultConfig(): Config {
  return {
    tickMs: 100,
    maxTurnSeconds: 1,
    maxSilenceSeconds: 1,
    maxTurns: 3,
    maxRepeatedToolCalls: 2,
    enableStandingReminder: false,
  }
}

/** Config with only the turn-budget rule enabled (others disabled). */
function turnBudgetOnlyConfig(): Config {
  return {
    tickMs: 100,
    maxTurnSeconds: 1,
    maxSilenceSeconds: 0,
    maxTurns: 0,
    maxRepeatedToolCalls: 0,
    enableStandingReminder: false,
  }
}

/** Config with only the turn cap enabled. */
function turnCapOnlyConfig(maxTurns: number): Config {
  return {
    tickMs: 50,
    maxTurnSeconds: 0,
    maxSilenceSeconds: 0,
    maxTurns,
    maxRepeatedToolCalls: 0,
    enableStandingReminder: false,
  }
}

/** Long-running model script that hangs until aborted, emitting NO progress chunks. */
function silentHangScript(_options: GenerateOptions): AsyncIterable<StreamChunk> {
  return (async function* () {
    // Yield nothing at all — the observer sees no progress events during this
    // turn, so the silence budget can trip. The call stays open until abort.
    await new Promise<void>((resolve) => {
      const signal = _options.signal
      if (signal?.aborted) { resolve(); return }
      signal?.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })()
}

async function harness(script: (options: GenerateOptions) => AsyncIterable<StreamChunk>, cfg: Config = defaultConfig()) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(observer, cfg)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId(`observer-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  ctx.llm.registerAdapter(['mock'], new ScriptedYieldingAdapter(script))
  return { ctx, agent }
}

/** Minimal adapter that yields the caller's async script. */
class ScriptedYieldingAdapter extends MockAdapter {
  constructor(private readonly scriptFn: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
    super([])
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for await (const chunk of this.scriptFn(options)) yield chunk
  }
}

/** Collect durable `observer/notice` event payloads from a session, narrowed to the notice type. */
function noticeData(agent: Agent): observer.ObserverNoticeData[] {
  return agent.session.events
    .filter((event): event is SessionEvent & { type: 'observer/notice'; data: observer.ObserverNoticeData } =>
      event.type === 'observer/notice')
    .map(event => event.data)
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

describe('observer rule evaluation', () => {
  it('injects a level-1 reminder when a turn runs past maxTurnSeconds', async () => {
    const { ctx, agent } = await harness(_options => silentHangScript(_options), turnBudgetOnlyConfig())
    contexts.push(ctx)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do the slow thing' }], source: { kind: 'user' } }))

    // The agent is mid-turn; the observer's tick fires turn-budget.
    await vi.advanceTimersByTimeAsync(2500)

    const fired = noticeData(agent)
    expect(fired.some(d => d.rule === 'turn-budget' && d.level === 1)).toBe(true)
    expect(fired.some(d => d.text.includes('budget'))).toBe(true)

    agent.cancel({ kind: 'parent' })
    await vi.advanceTimersByTimeAsync(50)
  })

  it('steers on the silence budget when no progress events arrive', async () => {
    const { ctx, agent } = await harness(_options => silentHangScript(_options))
    contexts.push(ctx)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stall forever' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(1500)

    const fired = noticeData(agent)
    expect(fired.some(d => d.rule === 'silence-budget' && d.level === 2)).toBe(true)
    expect(fired.some(d => d.text.includes('no progress'))).toBe(true)

    agent.cancel({ kind: 'parent' })
    await vi.advanceTimersByTimeAsync(50)
  })

  it('cancels on the turn cap with an observer hook cause', async () => {
    const script: StreamChunk[] = Array.from({ length: 4 }, () => textResponse('ack')).flat()
    const { ctx, agent } = await harness(_options => fromChunks(script), turnCapOnlyConfig(3))
    contexts.push(ctx)

    // Drive 3 turns; the cap (maxTurns=3) fires when turnCount reaches 3.
    for (let i = 0; i < 3; i++) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `turn ${i}` }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(200)

    const fired = noticeData(agent)
    expect(fired.some(d => d.rule === 'turn-cap' && d.level === 3)).toBe(true)

    // The durable turn-end eventually records the hook cause.
    await vi.advanceTimersByTimeAsync(500)
    const turnEnds = agent.session.events.filter(event => event.type === 'turn/end')
    const abortedByObserver = turnEnds.some((event) => {
      const reason = event.data.reason
      return reason.kind === 'aborted' && reason.reason.kind === 'hook'
        && reason.reason.reason.includes('observer turn-cap')
    })
    expect(abortedByObserver).toBe(true)
  })

  it('cedes to a context handoff: no observer intervention after a durable context/handoff', async () => {
    const { ctx, agent } = await harness(_options => silentHangScript(_options), turnBudgetOnlyConfig())
    contexts.push(ctx)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do the slow thing' }], source: { kind: 'user' } }))

    // The owner requests a verbatim handoff; the handoff flow owns termination.
    agent.session.append('context/handoff', {
      target: 'mock/mock',
      totalTokens: 800,
      contextWindow: 1000,
      thresholdTokens: 600,
      ratio: 0.6,
      reason: '800 >= 600 (0.6 of 1000)',
      cycle: 3,
    })

    // Even as the turn budget (1s) long expires, the observer stays silent.
    await vi.advanceTimersByTimeAsync(2500)
    expect(noticeData(agent)).toHaveLength(0)

    agent.cancel({ kind: 'parent' })
    await vi.advanceTimersByTimeAsync(50)
  })

  it('steers on repeated identical tool calls', async () => {
    // The model requests the same tool call 4 times; the repeat chain fires at
    // maxRepeatedToolCalls=2 and steers (level 2). A MockAdapter script array
    // makes each tool-call response one separate model call, mirroring the
    // real loop (call → result → call again).
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(observer, {
      tickMs: 50,
      maxTurnSeconds: 0,
      maxSilenceSeconds: 0,
      maxTurns: 0,
      maxRepeatedToolCalls: 2,
      enableStandingReminder: false,
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(
      Array.from({ length: 4 }, (_, i) => toolCallResponse(`c${i}`, 'bash', { command: 'ls' }, `run ${i}`)),
    ))
    const agent = ctx.agentLoop.create(SessionId(`observer-repeat-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the loop' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(2000)

    const fired = noticeData(agent)
    expect(fired.some(d => d.rule === 'repeated-tool' && d.level === 2)).toBe(true)

    agent.cancel({ kind: 'parent' })
    await vi.advanceTimersByTimeAsync(50)
  })

  it('appends observer/notice before the hook-caused turn end (invariant ordering)', async () => {
    const script: StreamChunk[] = Array.from({ length: 4 }, () => textResponse('ack')).flat()
    const { ctx, agent } = await harness(_options => fromChunks(script), turnCapOnlyConfig(3))
    contexts.push(ctx)

    // Drive 3 turns; the cap fires a level-3 notice on the turn boundary.
    for (let i = 0; i < 3; i++) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `turn ${i}` }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(500)

    const events = agent.session.events
    const noticeIndex = events.findIndex(event =>
      event.type === 'observer/notice' && event.data.level === 3)
    const turnEndIndex = events.findIndex((event) => {
      if (event.type !== 'turn/end') return false
      const reason = event.data.reason
      return reason.kind === 'aborted' && reason.reason.kind === 'hook'
    })
    expect(noticeIndex).toBeGreaterThanOrEqual(0)
    if (turnEndIndex >= 0) {
      expect(noticeIndex).toBeLessThan(turnEndIndex)
    }
  })
})

describe('observer config', () => {
  it('rejects non-positive or non-finite budgets as disabled rather than firing', async () => {
    const { ctx, agent } = await harness(_options => silentHangScript(_options), {
      tickMs: 100,
      maxTurnSeconds: 0,
      maxSilenceSeconds: 0,
      maxTurns: 0,
      maxRepeatedToolCalls: 0,
      enableStandingReminder: false,
    })
    contexts.push(ctx)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'never fires' }], source: { kind: 'user' } }))
    await vi.advanceTimersByTimeAsync(2000)

    expect(noticeData(agent)).toHaveLength(0)
    agent.cancel({ kind: 'parent' })
    await vi.advanceTimersByTimeAsync(50)
  })
})

/** Wrap a plain stream into the async iterable the adapter consumes. */
async function* fromChunks(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}
