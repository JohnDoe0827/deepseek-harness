/**
 * `OpenCodeGoAdapter`: fetch + SSE against the OpenCode Go
 * (OpenCode Zen Go subscription) OpenAI-compatible chat-completions endpoint,
 * emitting harness StreamChunks. The adapter is transport-only: connection
 * facts arrive through a thunk resolved once per operation and the bearer
 * token through a per-request resolver, so the registering plugin owns
 * validation, layering, and credential policy.
 *
 * @module dsh-llm-opencode-go/adapter
 */

/* jscpd:ignore-start -- Direct-fetch adapters share the OpenAI-compatible
 * request/SSE/watchdog pipeline shape with dsh-llm-deepseek; extracting a
 * shared transport layer is tracked as deferred work (see the package
 * Agent Note), so the clones stay local to the two adapters. */

import { attributionHeaders, LlmAdapter, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { got } from 'got'
import type { Response as GotResponse } from 'got'
import { Readable } from 'node:stream'
import { serializeRequest } from './serialize.ts'
import { DONE, translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface OpenCodeGoCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link OpenCodeGoConnectionOptions.maxTokens}. */
  maxTokens?: number
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface OpenCodeGoConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Default per-request output cap; explicit request values and model caps win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly OpenCodeGoCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link OpenCodeGoAdapter}: the operation-local resolution hooks the plugin owns. */
export interface OpenCodeGoAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => OpenCodeGoConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: OpenCodeGoConnectionOptions) => Promise<string>
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function modelInfo(provider: string, model: OpenCodeGoCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** First value of one (possibly repeated) response header. */
function headerValue(headers: GotResponse['headers'], name: string): string | undefined {
  const value = headers[name]
  return value === undefined ? undefined : Array.isArray(value) ? value[0] : value
}

function requestId(headers: GotResponse['headers']): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headerValue(headers, 'x-request-id')
  return value === undefined || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment skipping — is
 * `eventsource-parser`'s. The literal `[DONE]` is yielded so the translator
 * owns final flushing, and EOF before it raises `LlmError`.
 */
async function* parseSse(stream: ReadableStream<BufferSource>): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * The OpenCode Go adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class OpenCodeGoAdapter extends LlmAdapter {
  constructor(private readonly config: OpenCodeGoAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode Go' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // The chat-completions wire route is text-only regardless of catalog
      // membership, so the uncatalogued fallback declares the same negative
      // capability.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      // No defaultMaxTokens and no reasoning ladder: the OpenAI-compatible
      // surface does not document a stable effort vocabulary, so explicit
      // reasoning-effort requests fail with UNSUPPORTED_REASONING_EFFORT
      // instead of being silently dropped, and the provider's own output
      // cap applies unless the profile names one.
      ...configured?.maxTokens !== undefined || connection.maxTokens !== undefined
        ? { defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens }
        : {},
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, apiKey)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `OpenCode Go stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('OpenCode Go request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`OpenCode Go API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('OpenCode Go stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: OpenCodeGoConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const payload = JSON.stringify(serializeRequest(options))
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }

    // got negotiates HTTP/2 first and falls back to HTTP/1.1 automatically —
    // the same transport shape as the OpenCode client, whose connections this
    // route is expected to match — and never reads environment proxies, so
    // every request connects directly from the machine's real origin. The
    // endpoint's regional gating (the China-hosted deepseek opt-in) keys off
    // the request origin, and a proxied exit from an overseas IP silently
    // flips that state, so this route must never ride an ambient proxy. The
    // harness retry policy owns retries, redirects are refused, and status
    // handling stays here so the stable error mapping applies (see the
    // package Agent Note).
    const stream = got.stream(`${connection.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: payload,
      signal,
      http2: true,
      retry: { limit: 0 },
      followRedirect: false,
      throwHttpErrors: false,
    })
    let response: GotResponse
    try {
      response = await new Promise<GotResponse>((resolve, reject) => {
        stream.once('response', resolve)
        stream.once('error', reject)
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // got wraps every transport failure (DNS, refused connection, TLS) in a
      // RequestError whose actionable detail lives on `cause`. Wrapping with
      // the endpoint and chaining the cause lets `errorChain` render the full
      // diagnosis at every reporting boundary.
      throw new LlmError(
        `OpenCode Go API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let message = `OpenCode Go API error (HTTP ${response.statusCode})`
      let providerError: WireError['error']
      try {
        let errorText = ''
        for await (const chunk of stream as AsyncIterable<Buffer>) errorText += chunk.toString()
        const parsed = JSON.parse(errorText) as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(headerValue(response.headers, 'retry-after') ?? null)
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.statusCode), {
        status: response.statusCode,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }

    // @types/node types the web ReadableStream from toWeb as `any`; the node
    // stream it wraps yields byte chunks, which is what parseSse consumes.
    yield* translate(parseSse(Readable.toWeb(stream) as ReadableStream<BufferSource>))
  }
}
/* jscpd:ignore-end */
