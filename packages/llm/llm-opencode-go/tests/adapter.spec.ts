import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmError } from '@deepseek-ai/dsh-llm'
import * as LlmOpenCodeGo from '@deepseek-ai/dsh-llm-opencode-go'
import { OpenCodeGoAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-opencode-go'
import { got } from 'got'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function harness(baseURL: string, config: object = {}) {
  // Configuration carries only the reference; the key comes from the
  // environment, which is the whole credential plane without a mounted seam.
  vi.stubEnv('OPENCODE_GO_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpenCodeGo, { baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmOpenCodeGo.Config> & { apiKey?: string } = {}): OpenCodeGoAdapter {
  const { apiKey, ...rest } = config
  return new OpenCodeGoAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

const MESSAGES = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('OpenCodeGoAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 })

    const request = server.requests[0] as { model: string; stream: boolean; messages: { role: string }[] }
    expect(request.model).toBe('kimi-k3')
    expect(request.stream).toBe(true)
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'hi' })
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
  }, 30_000)

  it('sends the conversation session id as the x-opencode-session header', async () => {
    // OpenCode Go keys routing and prompt-cache optimization off a stable
    // per-conversation id and errors on requests without the header, so the
    // harness session id — stable across the whole conversation, resumes
    // included — rides every request of that conversation.
    const server = await mockServer([{ kind: 'sse', events: textEvents }, { kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const sessionId = 'main-session-3f0c4a9e-1e0f-4d5a-9c2b-6b0d4f7a8c21' as NonNullable<GenerateOptions['sessionId']>
    await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES, sessionId })
    await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES, sessionId })
    expect(server.headers[0]?.['x-opencode-session']).toBe(sessionId)
    expect(server.headers[1]?.['x-opencode-session']).toBe(sessionId)
  }, 30_000)

  it('sends a UUID x-opencode-session header even without a session id', async () => {
    // The header is required on every request, so a sessionless (hand-built,
    // out-of-loop) request still carries one — a fresh UUID that claims no
    // cross-request conversation identity.
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(server.headers[0]?.['x-opencode-session']).toMatch(UUID_RE)
  }, 30_000)

  it('streams tool calls as interleaved deltas', async () => {
    const server = await mockServer([{
      kind: 'sse',
      events: [
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":""}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.finish).toEqual({ kind: 'tool-calls' })
    expect(result.message.content).toEqual([{
      type: 'tool-call',
      id: 'c1',
      name: 'read_file',
      arguments: '{"path":"a"}',
    }])
  }, 30_000)

  it('maps HTTP errors to stable finish codes and carries the provider message', async () => {
    const server = await mockServer([
      { kind: 'http-error', status: 401, body: '{"error":{"message":"bad key"}}' },
      { kind: 'http-error', status: 429, body: '{"error":{"code":"rate_limit"}}' },
      { kind: 'http-error', status: 500, body: 'oops' },
    ])
    const ctx = await harness(server.url)
    const first = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(first.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH', message: 'bad key' } })
    const second = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(second.finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
    const third = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(third.finish).toMatchObject({ kind: 'error', failure: { code: 'SERVER' } })
  }, 30_000)

  it('fails with MISSING_CREDENTIAL before any request when no key exists', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('OPENCODE_GO_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCodeGo, { baseURL: server.url })
    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(server.requests).toHaveLength(0)
  }, 30_000)

  it('honors an aborted caller signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 40 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const pending = assemble(ctx, { model: 'kimi-k3', messages: MESSAGES, signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  }, 30_000)

  it('reports a destroyed connection as a transport error', async () => {
    // Dropping the socket mid-stream is a transport failure, not a clean EOF;
    // the truncation case (clean EOF without [DONE]) is covered in
    // translate.spec.ts as STREAM_CLOSED.
    const server = await mockServer([{ kind: 'close-early', events: ['{"choices":[{"delta":{"content":"half"}}]}'] }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'TRANSPORT' } })
  }, 30_000)

  it('requests through got with HTTP/2 first and no ambient retries, redirects, or status throws', async () => {
    // The transport contract: http2-first with automatic HTTP/1.1 fallback
    // (matching the OpenCode client), retries owned by the harness retry
    // policy, redirects refused, and status handling left to the adapter's
    // stable error mapping.
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const original = got.stream
    const calls: Array<{ url: unknown; options: unknown }> = []
    const spy = vi.spyOn(got, 'stream').mockImplementation((url: unknown, options?: unknown) => {
      calls.push({ url, options })
      return original(url as string, options as never)
    })
    try {
      const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
      expect(result.finish).toEqual({ kind: 'stop' })
    } finally {
      spy.mockRestore()
    }
    expect(calls).toHaveLength(1)
    const options = calls[0]?.options as Record<string, unknown> | undefined
    expect(options?.http2).toBe(true)
    expect(options?.retry).toEqual({ limit: 0 })
    expect(options?.followRedirect).toBe(false)
    expect(options?.throwHttpErrors).toBe(false)
    expect(options?.method).toBe('POST')
    expect(String(options?.body)).toContain('"model":"kimi-k3"')
  }, 30_000)

  it('connects directly even with proxy environment variables set', async () => {
    // got never reads environment proxies, so OpenCode Go requests always
    // leave from the machine's real origin regardless of ambient proxy config
    // (a dead proxy would fail the request if it were honored).
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1')
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1')
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests).toHaveLength(1)
  }, 30_000)
})

describe('resolveAdapterOptions', () => {
  it('defaults the endpoint to the public API and the key env to OPENCODE_GO_API_KEY', () => {
    const options = resolveAdapterOptions({})
    expect(options.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(String(options.apiKeyEnv)).toBe('OPENCODE_GO_API_KEY')
    expect(options.models.map(model => model.id)).toContain('deepseek-v4.1-flash')
    expect(options.models).toHaveLength(73)
    expect(options.models.map(model => model.id)).toEqual([
      'big-pickle', 'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-4-5',
      'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
      'claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5',
      'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro', 'deepseek-v4.1-flash',
      'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
      'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
      'glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash',
      'gpt-5', 'gpt-5-codex', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini', 'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.3-codex-spark',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro', 'gpt-5.5', 'gpt-5.5-pro',
      'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra',
      'grok-4.5', 'grok-4.6', 'grok-build-0.1',
      'jev-1.13', 'jev-1.13-free', 'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
      'ling-3.0-flash-fin-free', 'mimo-v2.6-flash-free', 'minimax-m2.5', 'minimax-m2.7', 'minimax-m3',
      'muse-spark-1.2', 'muse-spark-1.2-contributor-free', 'muse-spark-1.3', 'muse-spark-1.3-contributor-free',
      'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      'qwen3.5-plus', 'qwen3.6-plus', 'qwen3.8-flash',
    ])
  })

  it('prefers the trusted environment endpoint over the public default', () => {
    const environment = createLaunchEnvironmentSnapshot([
      { source: 'user-env', path: '/home/.dsh/.env', values: { OPENCODE_GO_BASE_URL: 'https://gateway.example.com' } },
    ])
    expect(resolveAdapterOptions({}, environment).baseURL).toBe('https://gateway.example.com')
    // An explicitly configured endpoint outranks every environment layer.
    const shell = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { OPENCODE_GO_BASE_URL: 'https://stale.example' } },
    ])
    expect(resolveAdapterOptions({ baseURL: 'https://gateway.internal' }, shell).baseURL).toBe('https://gateway.internal')
  })

  it('rejects invalid bounds', () => {
    expect(() => resolveAdapterOptions({ maxTokens: 0 })).toThrow('maxTokens must be a positive safe integer')
    expect(() => resolveAdapterOptions({ defaultContextWindow: 1.5 })).toThrow('positive integer')
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 })).toThrow('streamIdleTimeoutMs')
    expect(() => resolveAdapterOptions({ models: [{ id: 'a' }, { id: 'a' }] })).toThrow('duplicate catalog model')
  })
})

describe('adapter metadata', () => {
  it('exposes catalog models and resolves uncatalogued models as text-only with the default window', async () => {
    const adapter = adapterOf({ apiKey: 'k' })
    const models = await adapter.listModels('opencode-go')
    expect(models.map(model => model.id)).toContain('kimi-k3')
    const resolved = await adapter.resolveModel('opencode-go', 'some-new-model')
    expect(resolved).toMatchObject({
      provider: 'opencode-go', id: 'some-new-model', inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
    })
    expect(resolved.reasoning).toBeUndefined()
    expect(resolved.defaultMaxTokens).toBeUndefined()
  })

  it('materializes a profile maxTokens cap on exact catalog models', async () => {
    const adapter = adapterOf({ apiKey: 'k', maxTokens: 4096, models: [{ id: 'm1' }] })
    const resolved = await adapter.resolveModel('opencode-go', 'm1')
    expect(resolved.defaultMaxTokens).toBe(4096)
  })

  it('rejects explicit reasoning effort on the OpenAI surface', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCodeGo, { baseURL: 'http://127.0.0.1:1' })
    vi.stubEnv('OPENCODE_GO_API_KEY', 'k')
    let caught: LlmError | undefined
    try {
      await ctx.llm.prepareCall({
        provider: 'opencode-go', model: 'kimi-k3', reasoningEffort: ReasoningEffortId('high'),
      })
    } catch (error: unknown) {
      caught = error as LlmError
    }
    expect(caught?.code).toBe('UNSUPPORTED_REASONING_EFFORT')
  })
})
