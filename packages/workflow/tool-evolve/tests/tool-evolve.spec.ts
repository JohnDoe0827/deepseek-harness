import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import * as toolEvolve from '../src/index.ts'

const testToolSignal = new AbortController().signal

class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  settle!: (result: WorkflowResult) => void
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError !== undefined) throw this.startError
    this.requests.push(request)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    return {
      id: WorkflowRunId(`evolve-${this.requests.length}`),
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({
          value: null,
          stopReason: 'cancelled',
          ...reason === undefined ? {} : { error: reason },
          agentsStarted: 0,
        })
      },
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    }
  }
}

class StubProvider implements SubagentProvider {
  readonly name = 'fresh'
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean

  constructor(options?: { outputSchema?: boolean; inheritsParentContext?: boolean }) {
    this.capabilities = {
      outputSchema: options?.outputSchema ?? true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    }
    this.inheritsParentContext = options?.inheritsParentContext ?? false
  }

  start(_request: SubagentStartRequest): Promise<SubagentRun> {
    return Promise.reject(new Error('StubProvider.start must not be reached behind StubEngine'))
  }
}

interface SetupOptions {
  config?: toolEvolve.Config
  provider?: StubProvider | false
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  const provider = options?.provider === false ? undefined : options?.provider ?? new StubProvider()
  if (provider !== undefined) ctx.subagents.registerProvider(provider)
  await ctx.plugin(StubEngine)
  const config: toolEvolve.Config = { subagentProvider: 'fresh' }
  if (options?.config?.subagentProvider !== undefined) config.subagentProvider = options.config.subagentProvider
  if (options?.config?.maxIterations !== undefined) config.maxIterations = options.config.maxIterations
  if (options?.config?.maxNodeChars !== undefined) config.maxNodeChars = options.config.maxNodeChars
  if (options?.config?.maxResultChars !== undefined) config.maxResultChars = options.config.maxResultChars
  if (options?.config?.nodeMode !== undefined) config.nodeMode = options.config.nodeMode
  const fiber = await ctx.plugin(toolEvolve, config)
  const parent = { id: SessionId('caller'), options: {} } as unknown as Agent
  return { ctx, engine: ctx.workflowEngine as StubEngine, parent, fiber }
}

function execute(
  ctx: Context,
  args: unknown,
  extra?: { agent?: Agent; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: extra?.signal ?? testToolSignal,
    callId: CallId('evolve-call'),
    name: 'evolve',
    arguments: args,
    ...extra?.agent === undefined ? {} : { agent: extra.agent },
  })
}

const CONTINUE_NODE = {
  verdict: 'continue',
  summary: 'Advanced the branch.',
  work: 'Wrote the first implementation slice.',
  evidence: ['Focused tests pass.'],
  mutation: '',
}

const COMPLETE_NODE = {
  verdict: 'complete',
  summary: 'The seed is fully formed.',
  work: 'Finished and verified the complete artifact.',
  evidence: ['All gates pass.'],
  mutation: '',
}

const REGRESS_NODE = {
  verdict: 'regress',
  summary: 'The branch regressed; undid this round and will mutate.',
  work: 'Attempted X then reverted the workspace.',
  evidence: ['X failed the acceptance bar.'],
  mutation: 'Switch to strategy Y.',
}

const BLOCKED_NODE = {
  verdict: 'blocked',
  summary: 'No meaningful progress without external input.',
  work: 'Investigated; target depends on an external state.',
  evidence: ['External service is unavailable.'],
  mutation: '',
}

async function settleCompleted(
  engine: StubEngine,
  pending: Promise<ToolExecutionResult>,
  value: unknown,
  agentsStarted = 1,
): Promise<ToolExecutionResult> {
  await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThan(0) })
  engine.settle({ value, stopReason: 'completed', agentsStarted })
  return pending
}

describe('dsh-tool-evolve', () => {
  it('starts the fixed workflow through the configured fresh provider and renders completion', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxIterations: 9, maxNodeChars: 9000 } })
    const pending = execute(ctx, {
      seed: '  Form a counter module.  ',
      iterations: 4,
      nutrients: ['reference: the existing utils file'],
      nodeMode: 'workspace',
      mutateOnRegress: true,
    }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    expect(engine.requests[0]).toMatchObject({
      meta: { name: 'evolve-loop' },
      args: {
        seed: 'Form a counter module.',
        iterations: 4,
        nutrients: ['reference: the existing utils file'],
        nodeMode: 'workspace',
        mutateOnRegress: true,
        maxNodeChars: 9000,
      },
      subagentProvider: 'fresh',
      maxTotalAgents: 4,
      parent,
    })
    expect(engine.requests[0]!.script).toContain("status: 'budget-limited'")
    expect(engine.requests[0]!.script).toContain('regress')
    expect(engine.requests[0]!.script).toContain('mutation')
    const result = await settleCompleted(engine, pending, {
      status: 'complete',
      iterations: 1,
      node: COMPLETE_NODE,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(`evolve failed: ${JSON.stringify(result.error ?? result.content)}`)
    expect((result.value as { runId: string }).runId).toMatch(/^evolve-1$/)
    expect((result.value as { result: { status: string } }).result.status).toBe('complete')
    expect((result.value as { result: { node: { summary: string } } }).result.node.summary).toContain('formed')
  })

  it('carries seed, nutrients, and node-mode defaults into round prompts', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, {
      seed: 'Optimize the query path.',
      iterations: 2,
      nutrients: ['profile: the hot query'],
    }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const args = engine.requests[0]!.args as Record<string, unknown>
    expect(args['seed']).toBe('Optimize the query path.')
    expect(args['iterations']).toBe(2)
    expect(args['nutrients']).toEqual(['profile: the hot query'])
    // Default nodeMode is workspace.
    expect(args['nodeMode']).toBe('workspace')
    // The script feeds the seed and nutrients to each round.
    expect(engine.requests[0]!.script).toContain('Seed (the immutable starting point')
    expect(engine.requests[0]!.script).toContain('Round nutrients')
    const result = await settleCompleted(engine, pending, {
      status: 'budget-limited',
      iterations: 2,
      node: CONTINUE_NODE,
    })
    expect((result.value as { result: { status: string } }).result.status).toBe('budget-limited')
  })

  it('report nodeMode forbids workspace writes and regress carries mutation or disables it', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, {
      seed: 'Analyze the failure modes.',
      iterations: 3,
      nodeMode: 'report',
      mutateOnRegress: false,
    }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const script = engine.requests[0]!.script
    expect(script).toContain('report mode: do NOT write files')
    // mutateOnRegress=false means the regress branch suppresses the mutation.
    expect(script).toContain("args.mutateOnRegress === false ? '' : node.mutation")
    engine.settle({
      value: { status: 'blocked', iterations: 1, node: BLOCKED_NODE },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    const result = await pending
    expect((result.value as { result: { status: string } }).result.status).toBe('blocked')
    expect((result.value as { result: { node: { verdict: string } } }).result.node.verdict).toBe('blocked')
  })

  it('decodes a regress node as a successful branch with its mutation preserved', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { seed: 'Build the parser.', iterations: 2 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const result = await settleCompleted(engine, pending, {
      status: 'budget-limited',
      iterations: 2,
      node: REGRESS_NODE,
    })
    expect((result.value as { result: { node: { verdict: string } } }).result.node.verdict).toBe('regress')
    expect((result.value as { result: { node: { mutation: string } } }).result.node.mutation).toContain('strategy Y')
  })

  it('rejects malformed nodes and requests outside the ceiling', async () => {
    const { ctx, engine, parent } = await setup({ config: { maxIterations: 3 } })
    // iterations above the ceiling.
    const ceilingResult = await execute(ctx, { seed: 'x', iterations: 9 }, { agent: parent })
    expect(ceilingResult.isError).toBe(true)
    expect((ceilingResult.error as { message: string }).message).toContain('exceeds the deployment ceiling')
    // empty seed.
    const emptyResult = await execute(ctx, { seed: '   ', iterations: 2 }, { agent: parent })
    expect(emptyResult.isError).toBe(true)
    expect((emptyResult.error as { message: string }).message).toContain('non-empty')
    // A workflow that settles a malformed terminal value must fail loud.
    const pending = execute(ctx, { seed: 'ok', iterations: 1 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settle({ value: { status: 'complete', iterations: 1, node: { verdict: 'complete' } }, stopReason: 'completed', agentsStarted: 1 })
    const malformed = await pending
    expect(malformed.isError).toBe(true)
    expect((malformed.error as { message: string }).message).toContain('malformed node')
  })

  it('requires a fresh structured provider', async () => {
    const { ctx, parent } = await setup({ provider: false })
    const result = await execute(ctx, { seed: 'x', iterations: 1 }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.error as { message: string }).message).toContain('not registered')
  })

  it('rejects a provider that inherits parent context', async () => {
    const { ctx, parent } = await setup({ provider: new StubProvider({ inheritsParentContext: true }) })
    const result = await execute(ctx, { seed: 'x', iterations: 1 }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.error as { message: string }).message).toContain('inherits parent context')
  })

  it('renders a child failure with the last node', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { seed: 'x', iterations: 2 }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settle({
      value: { status: 'round-failed', iterations: 2, lastNode: CONTINUE_NODE },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.error as { message: string }).message).toContain('child failed')
  })

  it('disposes the workflow run on abort', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { seed: 'x', iterations: 2 }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(engine.cancels.length).toBeGreaterThanOrEqual(1)
    expect(engine.disposed).toBe(1)
  })
})
