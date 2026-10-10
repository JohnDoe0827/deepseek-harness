/**
 * Register an {@link OpenCodeGoAdapter} for the `opencode-go` provider route on
 * `ctx.llm`, with connection facts resolved per request instead of frozen at
 * load: the plugin layers its `cordis.yml` entry config under the optional
 * `llm-opencode-go` user-settings section (`ctx.settings`) and resolves the API
 * key through the optional credential seam (`ctx.credentials`), so a changed
 * base URL, catalog, or key reaches the very next request without restarting
 * anything, while an in-flight stream keeps the facts it started with. The
 * one registration-captured fact — the retry policy — re-registers the route
 * in place when it changes.
 *
 * The provider route targets the OpenCode Zen Go subscription's
 * OpenAI-compatible surface (`https://opencode.ai/zen/go/v1`), so switching
 * the session's default model to an `opencode-go/*` model routes requests
 * through this adapter while DeepSeek and any other registered provider stay
 * available in the same picker.
 *
 * @module @deepseek-ai/dsh-llm-opencode-go
 */

/* jscpd:ignore-start -- Direct-fetch providers share the settings-layering and
 * credential-resolution registration shape with dsh-llm-deepseek; extracting a
 * shared provider-registration helper is tracked as deferred work (see the
 * package Agent Note). */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenCodeGoAdapter,
} from './adapter.ts'
import type { OpenCodeGoCatalogModel, OpenCodeGoConnectionOptions } from './adapter.ts'

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OpenCodeGoAdapter,
} from './adapter.ts'
export type { OpenCodeGoAdapterOptions, OpenCodeGoCatalogModel, OpenCodeGoConnectionOptions } from './adapter.ts'
export type * from './types.ts'

export const name = 'llm-opencode-go'
export const inject = ['llm']

const NS = settingsNamespace('llm-opencode-go')
const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'opencode-go'

/** Default advisory catalog: models served on the OpenCode Go OpenAI surface. */
const DEFAULT_MODELS: OpenCodeGoCatalogModel[] = [
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro Preview', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5', name: 'GLM-5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5', name: 'GPT-5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.1', name: 'GPT-5.1', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'jev-1.13', name: 'Jev 1.13', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'jev-1.13-free', name: 'Jev 1.13', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'muse-spark-1.2', name: 'Muse Spark 1.2', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-opencode-go` settings-section shape. Every field is optional in
 * yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load), and an omitted `maxTokens` leaves the provider's own output
 * cap in force.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `OPENCODE_GO_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $OPENCODE_GO_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Default per-request output cap; explicit request values and model caps win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the OpenCode Go catalog. */
  models?: OpenCodeGoCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<OpenCodeGoCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Public API default; the internal endpoint comes from $OPENCODE_GO_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'OPENCODE_GO_BASE_URL'

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly OpenCodeGoCatalogModel[] | undefined): OpenCodeGoCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-opencode-go: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-opencode-go: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-opencode-go: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-opencode-go: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-opencode-go: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside
 * the product CLI.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): OpenCodeGoConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-opencode-go: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-opencode-go: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-opencode-go: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-opencode-go: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: OpenCodeGoConnectionOptions | undefined
  const options = (): OpenCodeGoConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-opencode-go: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: OpenCodeGoConnectionOptions): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-opencode-go', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-opencode-go', ref)
      }
    }
    throw new LlmError(
      `llm-opencode-go: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new OpenCodeGoAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'OpenCode Go', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}

/* jscpd:ignore-end */
