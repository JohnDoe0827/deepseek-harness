/**
 * Model-facing evolution loop over the workflow and subagent seams. A seed,
 * an explicit iteration count, and per-round nutrients drive fresh structured
 * children; each child produces a formed NODE (workspace work or a structured
 * report), and a `regress` verdict triggers backtracking to the previous
 * healthy node with a mutation-carrying retry on the next round — DNA-style:
 * seed → formed node per round → nutrient injection → backtrack on regression
 * → mutation to explore a new branch.
 * @module @deepseek-ai/dsh-tool-evolve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'
// Declaration merge only: makes ctx.systemPrompt visible for section registration.
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-evolve'
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt']

/** Deployment policy for the evolution tool. */
export interface Config {
  /** Fresh structured-output provider used for every round (default `spawn`). */
  subagentProvider?: string
  /** Default and deployment ceiling for one call's iteration count (default 256). */
  maxIterations?: number
  /** Maximum serialized characters in one node handoff (default 16384). */
  maxNodeChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number
  /** Default node mode: `workspace` writes into the shared workspace + node file; `report` is structured-only (default `workspace`). */
  nodeMode?: 'workspace' | 'report'
}

/** Schemastery configuration for the evolve tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  maxIterations: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  maxNodeChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  nodeMode: z.union(['workspace', 'report'] as const).required(false),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxIterations: number
  readonly maxNodeChars: number
  readonly maxResultChars: number
  readonly nodeMode: 'workspace' | 'report'
}

type EvolveVerdict = 'continue' | 'complete' | 'blocked' | 'regress'

interface EvolveNode {
  readonly verdict: EvolveVerdict
  readonly summary: string
  readonly work: string
  readonly evidence: string[]
  readonly mutation: string
}

type EvolveRunStatus = 'complete' | 'blocked' | 'budget-limited'

interface EvolveRunResult {
  readonly status: EvolveRunStatus
  readonly iterations: number
  readonly node: EvolveNode
}

interface EvolveRoundFailure {
  readonly status: 'round-failed'
  readonly iterations: number
  readonly lastNode?: EvolveNode
}

type EvolveTerminalResult = EvolveRunResult | EvolveRoundFailure

interface EvolveCallArgs {
  seed: string
  iterations: number
  nutrients?: string[]
  nodeMode?: 'workspace' | 'report'
  mutateOnRegress?: boolean
}

const EVOLVE_META = {
  name: 'evolve-loop',
  description: 'Iterate from a seed with a fresh child per round, injecting nutrients and forming a node each round; regress backtracks with a mutation-carrying retry.',
  phases: [{ title: 'Evolution rounds', detail: 'One clean child context per evolve round.' }],
}

/**
 * Fixed, deployment-owned orchestration. The model supplies data only; it
 * cannot alter the loop, provider route, schema, handoff validation, or
 * backtracking policy. The script has no filesystem itself; backtracking is
 * performed BY the round's child (it has the full tool set) before it returns
 * its node, so the workspace rollback is real tool work, not orchestration API.
 */
const EVOLVE_SCRIPT = String.raw`
const nodeSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['continue', 'complete', 'blocked', 'regress'] },
    summary: { type: 'string' },
    work: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    mutation: { type: 'string' },
  },
  required: ['verdict', 'summary', 'work', 'evidence', 'mutation'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedOrEmpty(value) {
  return typeof value === 'string' && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function validateNode(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error('Evolve child returned no structured node')
  }
  if (!normalizedText(node.summary) || !normalizedText(node.work) || !normalizedOrEmpty(node.mutation)) {
    throw new Error('Evolve node summary/work must be non-empty and normalized; mutation may be empty')
  }
  if (!normalizedList(node.evidence)) {
    throw new Error('Evolve node evidence must contain only non-empty normalized strings')
  }
  switch (node.verdict) {
    case 'continue':
      if (node.evidence.length === 0) throw new Error('a continuing evolve node needs evidence')
      break
    case 'complete':
      if (node.evidence.length === 0) throw new Error('a complete evolve node needs evidence')
      break
    case 'blocked':
      break
    case 'regress':
      // A regression node must name the mutation the next round should try,
      // so the loop can branch rather than repeat the same failure.
      break
    default:
      throw new Error('Evolve node verdict is invalid')
  }
  const serialized = JSON.stringify(node)
  if (serialized.length > args.maxNodeChars) {
    throw new Error('Evolve node exceeds maxNodeChars (' + serialized.length + ' > ' + args.maxNodeChars + ')')
  }
  return node
}

function modeInstructions(nodeMode) {
  if (nodeMode === 'report') {
    return 'This round is report mode: do NOT write files or modify the workspace. Produce your work as the node's structured work/evidence only.'
  }
  return [
    'This round is workspace mode: perform concrete work in the shared workspace (write files, edit code, update configs) — the result IS the node.',
    'Before returning the node, if your verdict is regress, FIRST run git checkout -- . (or equivalent) to discard this round\'s workspace changes and return the workspace to the previous healthy node state; then return the node with the mutation the next round should try.',
  ].join(' ')
}

let previous
let mutationOfPrevious
phase('Evolution rounds')
for (let round = 1; round <= args.iterations; round += 1) {
  const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
  const nutrients = args.nutrients.length === 0
    ? '(none supplied)'
    : 'Round nutrients:\n' + args.nutrients.join('\n')
  const mutation = mutationOfPrevious === undefined || mutationOfPrevious === ''
    ? '(no active mutation)'
    : 'Active mutation to try this round: ' + mutationOfPrevious
  const prompt = [
    'You are one fresh worker in a foreground evolution loop. You receive no parent conversation and no prior child session.',
    'Seed (the immutable starting point and goal):\n' + args.seed,
    'Evolution round: ' + round + ' of ' + args.iterations + '.',
    modeInstructions(args.nodeMode),
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting; preserve established nodes; build on the previous node.',
    'Previous node:\n' + prior,
    nutrients,
    mutation,
    'Return one node with exact normalized strings. verdict continue means the branch advances; complete means the goal is met with concrete evidence; blocked means no meaningful progress without human input or external change; regress means this round\'s changes should be discarded (undo them in the workspace FIRST) and the next round should try a different mutation. mutation names the change of approach the next round should try (empty string when none).',
  ].join('\n\n')
  const rawNode = await agent(prompt, {
    label: 'Evolution round ' + round,
    phase: 'Evolution rounds',
    schema: nodeSchema,
  })
  if (rawNode === null) {
    return { status: 'round-failed', iterations: round, lastNode: previous ?? null }
  }
  const node = validateNode(rawNode)
  if (node.verdict === 'complete') return { status: 'complete', iterations: round, node }
  if (node.verdict === 'blocked') return { status: 'blocked', iterations: round, node }
  if (node.verdict === 'regress') {
    // Backtrack: do not carry this round's work forward; carry only its
    // mutation so the next round branches. The round's child already undid
    // the workspace changes it made.
    mutationOfPrevious = args.mutateOnRegress === false ? '' : node.mutation
    previous = node
    continue
  }
  previous = node
  mutationOfPrevious = node.mutation
}
return { status: 'budget-limited', iterations: args.iterations, node: previous }
`

const DESCRIPTION = 'Run a foreground evolution loop from a seed. Each round opens a fresh child with no '
  + 'parent conversation; the shared workspace is long-term memory, and each round forms a NODE — workspace work '
  + 'or a structured report — with nutrients injected per round. A regress verdict backtracks the workspace and '
  + 'carries a mutation to the next round. Returns at completion, a blocker, or the iteration budget. Ordinary '
  + 'same-session work belongs to goal tools; plain delegation to subagents or workflows.'

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxIterations = config.maxIterations ?? 256
  const maxNodeChars = config.maxNodeChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  const nodeMode = config.nodeMode ?? 'workspace'
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new TypeError('maxIterations must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxNodeChars) || maxNodeChars < 1) {
    throw new TypeError('maxNodeChars must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    throw new TypeError('maxResultChars must be a positive safe integer')
  }
  return { subagentProvider, maxIterations, maxNodeChars, maxResultChars, nodeMode }
}

/** Resolve one model-selected count against the deployment ceiling. */
function resolveIterations(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Evolve iterations must be a positive safe integer')
  }
  if (value > ceiling) {
    throw new TypeError(`Evolve iterations ${value} exceeds the deployment ceiling ${ceiling}`)
  }
  return value
}

/** Require the configured route to mean a genuinely fresh structured child. */
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(name)
  if (provider === undefined) {
    throw new Error(`Evolve subagent provider "${name}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`Evolve subagent provider "${name}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`Evolve subagent provider "${name}" inherits parent context; evolve requires a fresh provider`)
  }
  return provider
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

/** A string that is trimmed but may be empty (used for the optional mutation). */
function normalizedOrEmpty(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
}

/** Defensively decode the fixed script's node across a provider boundary. */
function readNode(value: unknown, expectedVerdict: EvolveVerdict, maxChars: number): EvolveNode {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'evidence,mutation,summary,verdict,work'
    || value['verdict'] !== expectedVerdict
    || !normalizedText(value['summary'])
    || !normalizedText(value['work'])
    || !normalizedOrEmpty(value['mutation'])
    || !normalizedList(value['evidence'])) {
    throw new Error('Evolve workflow returned a malformed node')
  }
  const node: EvolveNode = {
    verdict: expectedVerdict,
    summary: value['summary'],
    work: value['work'],
    evidence: value['evidence'],
    mutation: value['mutation'],
  }
  const chars = JSON.stringify(node).length
  if (chars > maxChars) {
    throw new Error(`Evolve workflow returned an oversized node (${chars} > ${maxChars})`)
  }
  return node
}

/** Defensively decode a node whose verdict is not predetermined (terminal budgets). */
function readNodeAnyVerdict(value: unknown, maxChars: number): EvolveNode {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'evidence,mutation,summary,verdict,work'
    || !['continue', 'complete', 'blocked', 'regress'].includes(String(value['verdict']))
    || !normalizedText(value['summary'])
    || !normalizedText(value['work'])
    || !normalizedOrEmpty(value['mutation'])
    || !normalizedList(value['evidence'])) {
    throw new Error('Evolve workflow returned a malformed node')
  }
  const node: EvolveNode = {
    verdict: value['verdict'] as EvolveVerdict,
    summary: value['summary'],
    work: value['work'],
    evidence: value['evidence'],
    mutation: value['mutation'],
  }
  const chars = JSON.stringify(node).length
  if (chars > maxChars) {
    throw new Error(`Evolve workflow returned an oversized node (${chars} > ${maxChars})`)
  }
  return node
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(value: unknown, maxIterations: number, maxNodeChars: number): EvolveTerminalResult {
  if (!isRecord(value)
    || typeof value['iterations'] !== 'number'
    || !Number.isSafeInteger(value['iterations'])
    || value['iterations'] < 1
    || value['iterations'] > maxIterations) {
    throw new Error('Evolve workflow returned a malformed terminal result')
  }
  const iterations = value['iterations']
  switch (value['status']) {
    case 'complete':
      if (Object.keys(value).sort().join(',') !== 'iterations,node,status') {
        throw new Error('Evolve workflow returned a malformed terminal result')
      }
      return { status: 'complete', iterations, node: readNode(value['node'], 'complete', maxNodeChars) }
    case 'blocked':
      if (Object.keys(value).sort().join(',') !== 'iterations,node,status') {
        throw new Error('Evolve workflow returned a malformed terminal result')
      }
      return { status: 'blocked', iterations, node: readNode(value['node'], 'blocked', maxNodeChars) }
    case 'budget-limited':
      if (Object.keys(value).sort().join(',') !== 'iterations,node,status') {
        throw new Error('Evolve workflow returned a malformed terminal result')
      }
      if (iterations !== maxIterations) {
        throw new Error('Evolve workflow returned budget-limited before the iteration limit')
      }
      return { status: 'budget-limited', iterations, node: readNodeAnyVerdict(value['node'], maxNodeChars) }
    case 'round-failed': {
      if (Object.keys(value).sort().join(',') !== 'iterations,lastNode,status') {
        throw new Error('Evolve workflow returned a malformed terminal result')
      }
      if (iterations === 1) {
        if (value['lastNode'] !== null) {
          throw new Error('Evolve workflow returned an invalid first-round failure')
        }
        return { status: 'round-failed', iterations }
      }
      if (value['lastNode'] === null) {
        throw new Error('Evolve workflow returned a round failure without its last node')
      }
      return {
        status: 'round-failed',
        iterations,
        lastNode: readNode(value['lastNode'], 'continue', maxNodeChars),
      }
    }
    default:
      throw new Error('Evolve workflow returned an unknown terminal status')
  }
}

/** A non-clean workflow finish is an error, never a partial evolve success. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `Evolve workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `Evolve workflow failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- WorkflowStopReason is closed; a future variant must fail loud here. */
    default:
      return `Evolve workflow ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

/** Bound complete parent-facing text, including its envelope and truncation marker. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** Render the fixed terminal envelope without presenting self-report as certification. */
function renderResult(result: EvolveRunResult, maxChars: number): string {
  const rounds = `${result.iterations} round${result.iterations === 1 ? '' : 's'}`
  let text: string
  switch (result.status) {
    case 'complete':
      text = `Evolve worker reached a complete node after ${rounds}.\nFinal node:\n${JSON.stringify(result.node, null, 2)}`
      break
    case 'blocked':
      text = `Evolve worker reported a blocker after ${rounds}.\nFinal node:\n${JSON.stringify(result.node, null, 2)}`
      break
    case 'budget-limited':
      text = `Evolve reached its ${rounds} budget; the worker reported work remaining.\nFinal node:\n${JSON.stringify(result.node, null, 2)}`
      break
  }
  return boundResult(text, maxChars)
}

/** Canonical evolve result fields shared by schema inference and rendering. */
const EVOLVE_OUTPUT_PROPERTIES = {
  runId: { type: 'string', required: true },
  agentsStarted: { type: 'integer', required: true },
  result: { type: 'json', required: true },
} as const

/** Render an ordinary child failure with the most recent durable node. */
function renderRoundFailure(result: EvolveRoundFailure, maxChars: number): string {
  const header = `Evolve round ${result.iterations} child failed before producing a structured node.`
  const text = result.lastNode === undefined
    ? `${header}\nNo previous node was available.`
    : `${header}\nLast successful node:\n${JSON.stringify(result.lastNode, null, 2)}`
  return boundResult(text, maxChars)
}

function presentCall(args: EvolveCallArgs): ToolCallView {
  return { card: 'generic', title: 'evolve', rawInput: args.seed }
}

function presentResult(args: EvolveCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Register the evolve tool with its explicit-ask usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:evolve',
    order: 117,
    text: 'Use the evolve tool when the direct human explicitly asks for iteration with a seed, explicit iteration count, nutrients, formed nodes, or backtracking/mutation. Each evolve round starts a fresh child; the shared workspace is durable memory; nodes are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation.',
  })
  ctx.tools.register(defineTool({
    name: 'evolve',
    description: DESCRIPTION,
    parameters: {
      seed: {
        type: 'string',
        required: true,
        description: 'The immutable starting point and goal for every evolve round.',
      },
      iterations: {
        type: 'number',
        required: true,
        description: 'Explicit iteration count for this run.',
      },
      nutrients: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional per-round nutrient materials injected into every round.',
      },
      nodeMode: {
        type: 'string',
        description: 'workspace (default) writes into the shared workspace; report is structured-only.',
      },
      mutateOnRegress: {
        type: 'boolean',
        description: 'Whether a regress node\'s mutation is carried to the next round (default true).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: EVOLVE_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResult(value.result as unknown as EvolveRunResult, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('Evolve tool requires a calling agent (exec.agent was undefined)')
      }
      const seed = args.seed.trim()
      if (seed.length === 0) throw new Error('Evolve seed must be a non-empty string')
      const iterations = resolveIterations(args.iterations, resolved.maxIterations)
      const nutrients = args.nutrients ?? []
      if (nutrients.some(n => n.trim().length === 0)) {
        throw new Error('Evolve nutrients must be non-empty strings')
      }
      const nodeMode = args.nodeMode ?? resolved.nodeMode
      if (nodeMode !== 'workspace' && nodeMode !== 'report') {
        throw new Error('Evolve nodeMode must be "workspace" or "report"')
      }
      const mutateOnRegress = args.mutateOnRegress ?? true
      void requireFreshProvider(ctx, resolved.subagentProvider)

      const run: WorkflowRun = ctx.workflowEngine.start({
        script: EVOLVE_SCRIPT,
        meta: EVOLVE_META,
        args: {
          seed,
          iterations,
          nutrients,
          nodeMode,
          mutateOnRegress,
          maxNodeChars: resolved.maxNodeChars,
        },
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: iterations,
        parent,
        signal: exec.signal,
      })
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) run.cancel('parent step aborted')

      try {
        const settled = await run.result
        const error = stopReasonError(settled)
        if (error !== undefined) throw new Error(error)
        const value = readRunResult(settled.value, iterations, resolved.maxNodeChars)
        if (value.status === 'round-failed') throw new Error(renderRoundFailure(value, resolved.maxResultChars))
        return {
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: value as unknown as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await run.dispose()
      }
    },
    presentCall,
    presentResult,
  }))
}
