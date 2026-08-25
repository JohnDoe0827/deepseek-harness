// Real-Loader composition for the fleet plugin: a cordis.yml mounts the
// plugin beside the command registry, the real llm runtime with a scripted
// test adapter, and the agent-default-model service. The tests drive the
// surfaces users hit — `/fleet run`, the `agent/turn-stopping` review hook,
// `/fleet resume` — and assert the durable ledger events and steering.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import * as Fleet from '@deepseek-ai/dsh-codewhale-fleet'

/** A scripted adapter: each call yields the next scripted text verbatim. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly scripts: readonly string[]) { super() }
  calls = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const script = this.scripts[this.calls] ?? '{"verdict":"pass","feedback":""}'
    this.calls++
    const text = script
    for (let index = 0; index < text.length; index += 8) {
      options.signal?.throwIfAborted()
      yield { type: 'text-delta', index: 0, text: text.slice(index, index + 8) }
    }
  }
}

let root: string | undefined
let context: Context | undefined
let adapter: ScriptedAdapter | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  adapter = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot a cordis.yml mounting the fleet plugin plus its consumed services. */
async function boot(scripts: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-fleet-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: test-provider',
    '    model: test-model',
    "- name: '@deepseek-ai/dsh-commands'",
    '- name: scripted-llm',
    "- name: '@deepseek-ai/dsh-codewhale-fleet'",
    '  config:',
    '    maxRounds: 2',
    '    maxTranscriptChars: 8000',
    '    roles:',
    '      - id: reviewer',
    '        label: Reviewer',
    '        instructions: Review the response against the task.',
    '',
  ].join('\n'))

  adapter = new ScriptedAdapter(scripts)
  const fakeLlmPlugin = {
    name: 'scripted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.registerAdapter(['test-provider'], adapter!)
    },
  }

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-commands', CommandRegistry],
    ['@deepseek-ai/dsh-codewhale-fleet', Fleet],
    ['scripted-llm', fakeLlmPlugin],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // The scripted adapter registers on activation; scripted-llm is an extra
  // entry appended to the config rows above via a second include.
  return ctx
}

/** An agent with a real session and recorded steer/inject mocks. */
function agent(): Agent & {
  session: Session
  steers: Mock<(message: UserMessage) => void>
  injects: Mock<(message: UserMessage) => void>
} {
  const session = Session.create(SessionId('fleet-session'))
  const steers = vi.fn<(message: UserMessage) => void>()
  const injects = vi.fn<(message: UserMessage) => void>()
  const value = {
    id: session.id, options: {}, session,
    steer: steers as unknown as Agent['steer'],
    inject: injects as unknown as Agent['inject'],
  } as unknown as Agent
  return Object.assign(value, { steers, injects })
}

/** The durable ledger events of one type from a session, narrowed to that type. */
function ledger<T extends SessionEvent['type']>(
  session: Session,
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return session.events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

/** Simulate the loop's stop boundary for the agent. */
function stopTurn(ctx: Context, agent: Agent, turn: number, step: number): Promise<unknown> {
  // The loop logs step boundaries before the stop boundary reads them.
  agent.session.append('step/end', { turn, step })
  return ctx.serial('agent/turn-stopping', {
    agent, turn, signal: new AbortController().signal,
  } as never)
}

describe('codewhale-fleet real Loader composition', () => {
  it('/fleet run steers the task and reviews at turn stop until a clean pass', async () => {
    const ctx = await boot(['{"verdict":"fix","feedback":"add tests"}', '{"verdict":"pass","feedback":""}'])
    const owner = agent()

    const started = await ctx.commands.execute(owner, '/fleet run implement the counter', new AbortController().signal)
    expect(started?.result.kind).toBe('success')
    expect(ledger(owner.session, 'fleet/run')).toHaveLength(1)
    expect(owner.steers).toHaveBeenCalledOnce()
    expect(owner.steers.mock.calls[0]?.[0]?.content).toEqual([{ type: 'text', text: 'implement the counter' }])

    // Turn 1 completes: the reviewer demands fixes and the feedback is steered.
    await stopTurn(ctx, owner, 1, 1)
    expect(ledger(owner.session, 'fleet/review')).toHaveLength(1)
    expect(ledger(owner.session, 'fleet/review')[0]?.data).toMatchObject({
      id: '1', role: 'reviewer', verdict: 'fix', feedback: 'add tests',
    })
    expect(owner.steers).toHaveBeenCalledTimes(2)
    expect(ledger(owner.session, 'fleet/end')).toHaveLength(0)

    // Same step again: no double review.
    await stopTurn(ctx, owner, 1, 1)
    expect(ledger(owner.session, 'fleet/review')).toHaveLength(1)

    // The fix step completes: the reviewer passes and the run closes clean.
    await stopTurn(ctx, owner, 1, 2)
    expect(ledger(owner.session, 'fleet/review')).toHaveLength(2)
    expect(ledger(owner.session, 'fleet/review')[1]?.data.verdict).toBe('pass')
    expect(ledger(owner.session, 'fleet/end')).toHaveLength(1)
    expect(ledger(owner.session, 'fleet/end')[0]?.data).toEqual({ id: '1', reason: 'clean' })
    expect(owner.steers).toHaveBeenCalledTimes(2)
  }, 30_000)

  it('closes fixes-exhausted at maxRounds and /fleet status renders the ledger', async () => {
    const ctx = await boot(['{"verdict":"fix","feedback":"keep fixing"}', '{"verdict":"fix","feedback":"still fixing"}'])
    const owner = agent()
    await ctx.commands.execute(owner, '/fleet run', new AbortController().signal)
    await stopTurn(ctx, owner, 1, 1)
    await stopTurn(ctx, owner, 1, 2)
    // Third boundary: two reviews recorded, the cap is reached.
    await stopTurn(ctx, owner, 1, 3)
    expect(ledger(owner.session, 'fleet/end')[0]?.data).toEqual({ id: '1', reason: 'fixes-exhausted' })

    const status = await ctx.commands.execute(owner, '/fleet', new AbortController().signal)
    expect((status?.result as { text?: string }).text).toContain('Run 1: 1 reviewer roles, ended: fixes-exhausted')
    expect((status?.result as { text?: string }).text).toContain('reviewer: fix')
  }, 30_000)

  it('/fleet resume re-runs reviews for an active run', async () => {
    const ctx = await boot(['{"verdict":"pass","feedback":""}'])
    const owner = agent()
    await ctx.commands.execute(owner, '/fleet run do the thing', new AbortController().signal)
    await stopTurn(ctx, owner, 1, 1)
    expect(ledger(owner.session, 'fleet/end')).toHaveLength(1)

    const resumed = await ctx.commands.execute(owner, '/fleet resume', new AbortController().signal)
    expect(resumed?.result.kind).toBe('error') // the run already ended
    expect((resumed?.result as { text: string }).text).toContain('No active fleet run')
  }, 30_000)

  it('ignores stop boundaries for sessions without an active run', async () => {
    const ctx = await boot([])
    const owner = agent()
    await stopTurn(ctx, owner, 1, 1)
    expect(ledger(owner.session, 'fleet/run')).toHaveLength(0)
    expect(adapter?.calls ?? 0).toBe(0)
  }, 30_000)
})
