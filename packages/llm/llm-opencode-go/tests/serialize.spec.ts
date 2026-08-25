import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { serializeMessages, serializeRequest } from '../src/serialize.ts'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistant(text: string) {
  return createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'opencode-go', model: 'kimi-k3' },
  })
}

function toolCallMessage(callId: string, name: string, args: string) {
  return createMessage({
    role: 'assistant',
    content: [{ type: 'tool-call', id: CallId(callId), name, arguments: args }],
    source: { kind: 'model', provider: 'opencode-go', model: 'kimi-k3' },
  })
}

function toolResult(callId: string, text: string) {
  return createUserMessage({
    content: [{ type: 'tool-result', toolCallId: CallId(callId), content: [{ type: 'text', text }] }],
    source: { kind: 'tool', name: 'tool', callId: CallId(callId) },
  })
}

describe('serializeMessages', () => {
  it('serializes system, user, and assistant messages', () => {
    const wire = serializeMessages([
      createMessage({ role: 'system', content: [{ type: 'text', text: 'be concise' }], source: { kind: 'plugin', plugin: 'test' } }),
      user('hello'),
      assistant('hi there'),
    ])
    expect(wire).toEqual([
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('replays assistant tool calls and expands tool results into role:tool messages', () => {
    const wire = serializeMessages([
      toolCallMessage('call-1', 'read_file', '{"path":"a.txt"}'),
      toolResult('call-1', 'file contents'),
      user('thanks'),
    ])
    expect(wire).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
      { role: 'user', content: 'thanks' },
    ])
  })

  it('sends an empty tool result as a placeholder instead of empty content', () => {
    const wire = serializeMessages([toolResult('call-2', '')])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-2', content: '(no output)' }])
  })

  it('rejects image content', () => {
    const withImage = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png', bytes: 68, width: 1, height: 1,
        },
      }],
      source: { kind: 'user' },
    })
    expect(() => serializeMessages([withImage])).toThrow(/does not support image content/)
  })
})

describe('serializeRequest', () => {
  it('builds a streaming request with optional fields omitted', () => {
    const request = serializeRequest({
      provider: 'opencode-go',
      model: 'kimi-k3',
      messages: [user('hello')],
      system: 'be concise',
    })
    expect(request).toEqual({
      model: 'kimi-k3',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('carries tools, temperature, maxTokens, and stop when set', () => {
    const request = serializeRequest({
      provider: 'opencode-go',
      model: 'kimi-k3',
      messages: [user('hello')],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 1000,
      stop: ['\n\n'],
    })
    expect(request.tools).toEqual([{
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    }])
    expect(request.temperature).toBe(0.2)
    expect(request.max_tokens).toBe(1000)
    expect(request.stop).toEqual(['\n\n'])
  })
})
