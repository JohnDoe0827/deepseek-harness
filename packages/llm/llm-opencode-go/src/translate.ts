/**
 * Translate OpenCode Go SSE payloads into the harness `StreamChunk` protocol.
 * One stateful block is kept per open content, reasoning, or tool-call index;
 * an empty initial delta does not open a block. Finish reason and the latest
 * usage are deferred until the `[DONE]` sentinel.
 * @module dsh-llm-opencode-go/translate
 */

/* jscpd:ignore-start -- The OpenAI-compatible chunk vocabulary (delta, finish,
 * usage) is the same protocol dsh-llm-deepseek translates; the mapping is a
 * protocol constant rather than owned logic (see the package Agent Note). */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { WireChunk, WireDelta, WireUsage } from './types.ts'

/** The terminal payload OpenCode Go (and OpenAI) send after the last chunk. */
export const DONE = '[DONE]'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. OpenAI's `prompt_tokens` INCLUDES cache hits, while
 * the harness TokenUsage convention is DISJOINT counts, so cache reads are
 * subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/** Apply one delta to the open blocks, yielding the deltas it produces. */
function* applyDelta(
  delta: WireDelta,
  blocks: { byKind: Map<string, OpenBlock>; byWireIndex: Map<number, OpenBlock>; order: OpenBlock[]; nextIndex: () => number },
): Generator<StreamChunk> {
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: blocks.nextIndex(), kind, text: '' }
    blocks.order.push(block)
    return block
  }

  const reasoning = delta.reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    let block = blocks.byKind.get('reasoning')
    if (!block) {
      block = open('reasoning')
      blocks.byKind.set('reasoning', block)
      yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
    }
    block.text += reasoning
    yield { type: 'reasoning-delta', index: block.index, text: reasoning }
  }

  const content = delta.content
  if (typeof content === 'string' && content.length > 0) {
    let block = blocks.byKind.get('text')
    if (!block) {
      block = open('text')
      blocks.byKind.set('text', block)
      yield { type: 'block-start', index: block.index, blockType: 'text' }
    }
    block.text += content
    yield { type: 'text-delta', index: block.index, text: content }
  }

  for (const call of delta.tool_calls ?? []) {
    const wireIndex = call.index ?? 0
    let block = blocks.byWireIndex.get(wireIndex)
    if (!block) {
      block = open('tool-call')
      blocks.byWireIndex.set(wireIndex, block)
      yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
    }
    if (call.id !== undefined) block.callId = call.id
    if (call.function?.name !== undefined) block.name = call.function.name
    const fragment = call.function?.arguments ?? ''
    block.text += fragment
    yield {
      type: 'tool-call-delta',
      index: block.index,
      id: CallId(block.callId ?? ''),
      ...block.name !== undefined ? { name: block.name } : {},
      argumentsDelta: fragment,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  const order: OpenBlock[] = []
  const byKind = new Map<string, OpenBlock>()
  const byWireIndex = new Map<number, OpenBlock>()
  let nextIndex = 0
  const state = {
    byKind,
    byWireIndex,
    order,
    nextIndex: () => nextIndex++,
  }
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      yield* applyDelta(choice.delta, state)
      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }
    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest. A wire `usage: null` (a completion
    // the endpoint reports without token accounting) is absent, not a count.
    if (chunk.usage != null) pendingUsage = mapUsage(chunk.usage)
  }

  // The caller's SSE framing guarantees the [DONE] sentinel (or throws);
  // reaching here means the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

/* jscpd:ignore-end */
