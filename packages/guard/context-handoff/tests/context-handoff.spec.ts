/**
 * Coverage for @deepseek-ai/dsh-context-handoff: the observer measures live
 * session token pressure on its own clock (fake timers, deterministic) and,
 * past the configured threshold, runs the backup runner, appends a durable
 * `context/handoff` event carrying the artifact paths, and injects the
 * fresh-session reminder — once per session. The backup runner is injected
 * (an in-memory fake), so the tests exercise the full measure→backup→notice
 * chain without child processes. The complement invariant tests live in
 * invariant.spec.ts.
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
import type { BackupArtifacts, Config } from '../src/index.ts'

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

/** A fake backup runner that resolves immediately (no child processes). */
function fakeBackupRunner(calls: BackupArtifacts[] = []): contextHandoff.BackupRunner {
  return async (opts): Promise<BackupArtifacts> => {
    const artifacts: BackupArtifacts = {
      bundlePath: `${opts.backupDir}/${opts.topic}.bundle`,
      tarballPath: `${opts.backupDir}/${opts.topic}-src.tar.gz`,
      notePath: `${opts.backupDir}/HANDOFF-${opts.topic}.md`,
    }
    calls.push(artifacts)
    return artifacts
  }
}

/** A mounted context with the token meter, the plugin, a real loop and agent. */
async function harness(overrides: Partial<Config> = {}): Promise<{ ctx: Context; agent: Agent; backups: BackupArtifacts[] }> {
  const backups: BackupArtifacts[] = []
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentDefaultModel, { provider: 'mock', model: 'mock' })
  await ctx.plugin(contextHandoff, {
    tickMs: 50,
    thresholdRatio: 0.6,
    backupDir: '/tmp/dsh-handoff-test',
    projectDir: '/tmp/dsh-handoff-project',
    backupRunner: fakeBackupRunner(backups),
    ...overrides,
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new ContextAdapter())
  const agent = ctx.agentLoop.create(SessionId(`handoff-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, agent, backups }
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
  it('runs the backup, appends a durable notice, and injects the reminder when pressure crosses the threshold', async () => {
    const { agent, backups } = await harness()
    const injected = vi.spyOn(agent, 'inject')
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(200)

    // The backup ran exactly once, before the notice.
    expect(backups).toHaveLength(1)
    expect(backups[0]?.bundlePath).toContain('.bundle')

    const notices = handoffs(agent)
    expect(notices.length).toBeGreaterThanOrEqual(1)
    const notice = notices[0]!
    expect(notice.ratio).toBe(0.6)
    expect(notice.contextWindow).toBe(1000)
    expect(notice.thresholdTokens).toBe(600)
    expect(notice.totalTokens).toBeGreaterThanOrEqual(600)
    expect(notice.target).toBe('mock/mock')
    // The notice carries the artifact paths written by the runner.
    expect(notice.backupDir).toBe('/tmp/dsh-handoff-test')
    expect(notice.bundlePath).toContain('.bundle')
    expect(notice.notePath).toContain('HANDOFF-')
    expect(notice.error).toBeUndefined()

    // The inject queued the reminder for the agent's next step, stating the
    // completed backup and the fresh-session instruction.
    expect(injected).toHaveBeenCalled()
    const payload = injected.mock.calls[0]?.[0]
    const text = JSON.stringify(payload?.content ?? '')
    expect(text).toContain('Backup complete')
    expect(text).toContain('open a fresh session')
  })

  it('records the handoff cycle and tells the fresh session to restore monitoring', async () => {
    const { agent } = await harness({ cycle: 2 })
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

  it('surfaces a backup failure in the durable notice without suppressing it', async () => {
    const failing: contextHandoff.BackupRunner = async () => {
      throw new Error('tar failed')
    }
    const { agent } = await harness({ backupRunner: failing })
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(200)

    const notices = handoffs(agent)
    expect(notices.length).toBeGreaterThanOrEqual(1)
    expect(notices[0]!.error).toContain('tar failed')
    // A failed backup still records the intended note path.
    expect(notices[0]!.notePath).toContain('HANDOFF-')
  })

  it('fires at most once per session even while pressure keeps rising', async () => {
    const { agent, backups } = await harness()
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(300)
    bloatSession(agent)
    await vi.advanceTimersByTimeAsync(300)

    expect(handoffs(agent).length).toBe(1)
    expect(backups).toHaveLength(1)
  })

  it('does not fire before the threshold', async () => {
    const { agent, backups } = await harness()
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'small message' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(300)
    expect(handoffs(agent)).toHaveLength(0)
    expect(backups).toHaveLength(0)
  })

  it('refuses self-backup: backupDir inside projectDir is rejected (barber paradox)', async () => {
    // Direct runner test (no timers): the default executor must refuse a
    // backup directory nested inside the project being archived.
    await expect(contextHandoff.defaultBackupRunner({
      backupDir: '/tmp/dsh-handoff-project/nested-backups',
      projectDir: '/tmp/dsh-handoff-project',
      topic: 'self',
      excludePatterns: ['.git', 'node_modules', 'lib'],
      sessionId: 'self-test',
      note: 'x',
    })).rejects.toThrow('self-backup refused')
  })

  it('self-verifies artifacts: a backup that wrote real files reports them verified', async () => {
    // Real timers: the runner performs real fs IO, which fake timers cannot
    // flush. The observer's tick fires on the real clock; wait for it.
    vi.useRealTimers()
    const { agent } = await harness({
      tickMs: 20,
      backupRunner: async (opts) => {
        const fs = await import('node:fs/promises')
        await fs.mkdir(opts.backupDir, { recursive: true })
        const notePath = `${opts.backupDir}/HANDOFF-${opts.topic}.md`
        await fs.writeFile(notePath, opts.note)
        const verified = (await fs.stat(notePath)).isFile() ? [notePath] : []
        return { notePath, verified }
      },
    })
    bloatSession(agent)
    await new Promise(resolve => setTimeout(resolve, 250))

    const notices = handoffs(agent)
    expect(notices.length).toBeGreaterThanOrEqual(1)
    // The note file was really written, so the runner's verification records it.
    expect(notices[0]!.verified?.some(path => path.includes('HANDOFF-'))).toBe(true)
  })
})
