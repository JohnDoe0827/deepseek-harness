/**
 * Coverage for @deepseek-ai/dsh-context-handoff: the observer measures live
 * session token pressure on its own clock (fake timers, deterministic) and,
 * past the configured threshold, appends a durable `context/handoff` event
 * and injects the skill reminder — once per session. The complement
 * invariant tests live in invariant.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { LlmAdapter, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as contextHandoff from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Adapter whose model exposes a 1000-token window (threshold = 600 at 0.6). */
class ContextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1000 } })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '{"verdict":"pass","feedback":""}'
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

/** A mounted context with the token meter, the plugin, a real loop and agent. */
async function harness(cfg: Config = {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
  await ctx.plugin(contextHandoff, cfg)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new ContextAdapter())
  const agent = ctx.agentLoop.create(SessionId(`handoff-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, agent }
}

/** The durable `context/handoff` payloads from a session. */
function handoffs(agent: Agent): contextHandoff.ContextHandoffNoticeData[] {
  return agent.session.events
    .filter((event): event is SessionEvent & { type: 'context/handoff' } => event.type === 'context/handoff')
    .map(event => event.data)
}

/** Append surface events until the session pressure crosses 600 tokens. */
function bloatSession(agent: Agent): void {
  // Each message prices ~9 + text tokens; 80 messages at ~30 chars cross 600.
  for (let index = 0; index < 80; index++) {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `incremental work item ${index} with enough text to price meaningfully past the small window` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
}

describe('dsh-context-handoff observer', () => {
  it('appends a durable notice and injects the reminder when pressure crosses the threshold', async () => {
    const { agent } = await harness({ tickMs: 50, thresholdRatio: 0.6 })
    const injected = vi.spyOn(agent, 'inject')
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(200)

    const notices = handoffs(agent)
    expect(notices.length).toBeGreaterThanOrEqual(1)
    const notice = notices[0]!
    expect(notice.ratio).toBe(0.6)
    expect(notice.contextWindow).toBe(1000)
    expect(notice.thresholdTokens).toBe(600)
    expect(notice.totalTokens).toBeGreaterThanOrEqual(600)
    expect(notice.target).toBe('mock/mock')

    // The inject queued the skill reminder for the agent's next step; the
    // durable notice is its record, and the injected payload names the skill.
    expect(injected).toHaveBeenCalled()
    const payload = injected.mock.calls[0]?.[0]
    expect(JSON.stringify(payload?.content ?? '')).toContain('dsh-context-handoff')
  })

  it('records the handoff cycle and tells the fresh session to restore monitoring', async () => {
    const { agent } = await harness({ tickMs: 50, thresholdRatio: 0.6, cycle: 2 })
    const injected = vi.spyOn(agent, 'inject')
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(200)

    const notice = handoffs(agent)[0]!
    expect(notice.cycle).toBe(2)
    const payload = injected.mock.calls[0]?.[0]
    const text = JSON.stringify(payload?.content ?? '')
    // The reminder names the next cycle so the fresh session bumps the config.
    expect(text).toContain('cycle 2')
    expect(text).toContain('cycle = 3')
    expect(text).toContain('monitoring loop continues')
  })

  it('fires at most once per session even while pressure keeps rising', async () => {
    const { agent } = await harness({ tickMs: 50, thresholdRatio: 0.6 })
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(300)
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(300)

    expect(handoffs(agent).length).toBe(1)
  })

  it('does not fire before the threshold', async () => {
    const { agent } = await harness({ tickMs: 50, thresholdRatio: 0.6 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'small message' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(300)
    expect(handoffs(agent)).toHaveLength(0)
  })
})
