import { describe, expect, it } from 'vitest'
import { mapFinishReason, translate } from '../src/translate.ts'

async function* feed(...payloads: string[]): AsyncGenerator<string> {
  for (const payload of payloads) yield payload
}

async function collect(payloads: string[]): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of translate(feed(...payloads))) chunks.push(chunk)
  return chunks
}

describe('translate', () => {
  it('assembles a text generation with usage and a stop finish', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"hello"}}]}',
      '{"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      '[DONE]',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'text-delta', index: 0, text: ' world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello world' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('opens reasoning and tool-call blocks from their deltas', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read_file', argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'read_file', argumentsDelta: '"a.txt"}' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('subtracts cached tokens from the input count', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":7}}}',
      '[DONE]',
    ])
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 7 },
    })
  })

  it('treats a wire usage of null as absent instead of crashing', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}',
      '[DONE]',
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps an empty completion to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await collect(['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } },
    })
  })

  it('rejects malformed payloads and missing [DONE]', async () => {
    await expect(collect(['not json'])).rejects.toThrow(/malformed SSE payload/)
    await expect(collect(['{"choices":[{"delta":{"content":"x"}}]}'])).rejects.toThrow('SSE payload stream ended without [DONE]')
  })
})

describe('mapFinishReason', () => {
  it('maps the standard vocabulary', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})
