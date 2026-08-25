/**
 * Real-composition guard for the opencode-go provider: LlmRuntime,
 * settings-file, credentials-local, and llm-opencode-go boot from a test-only
 * cordis.yml through the actual Loader + Include path. The first request goes
 * to one mock endpoint, an external edit of settings.yaml switches the base
 * URL (the "switch API" surface), and the very next request carries the fresh
 * endpoint and credential. A composition without settings or credentials
 * entries keeps entry-config behavior — the documented optional-inject
 * fallback.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmOpenCodeGo from '@deepseek-ai/dsh-llm-opencode-go'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-opencode-go')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function loadComposition(
  options: { withDynamic: boolean; baseURL: string },
): Promise<{ ctx: Context; settingsPath: string; credentialsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-opencode-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  if (options.withDynamic) {
    await writeFile(settingsPath, '# personal settings\n')
    await writeFile(credentialsPath, 'OPENCODE_GO_API_KEY: boot-key\n', { mode: 0o600 })
  }

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: 'test-llm-service'",
    ...options.withDynamic
      ? [
        '- id: settings',
        "  name: '@deepseek-ai/dsh-settings-file'",
        '  config:',
        `    path: ${JSON.stringify(settingsPath)}`,
        '    debounceMs: 10',
        '- id: credentials',
        "  name: '@deepseek-ai/dsh-credentials-local'",
        '  config:',
        `    path: ${JSON.stringify(credentialsPath)}`,
        '    debounceMs: 10',
      ]
      : [],
    '- id: llm-opencode-go',
    "  name: '@deepseek-ai/dsh-llm-opencode-go'",
    '  config:',
    `    baseURL: ${JSON.stringify(options.baseURL)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-opencode-go', LlmOpenCodeGo],
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
  return { ctx, settingsPath, credentialsPath }
}

const MESSAGES = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]

describe('llm-opencode-go real Loader composition', () => {
  it('registers the configurable provider and serves requests through the entry config', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('OPENCODE_GO_API_KEY', 'env-key')
    const { ctx } = await loadComposition({ withDynamic: false, baseURL: server.url })

    const catalog = ctx.llm.listConfigurableProviders()
    const entry = catalog.find(provider => provider.provider === 'opencode-go')
    expect(entry).toMatchObject({ provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: NS })

    const result = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(server.headers[0]?.authorization).toBe('Bearer env-key')
  }, 30_000)

  it('switches endpoints after a settings.yaml edit without restart (the API switch surface)', async () => {
    const first = await mockServer([{ kind: 'sse', events: textEvents }])
    const second = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsPath } = await loadComposition({ withDynamic: true, baseURL: first.url })

    const before = await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(before.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(first.requests).toHaveLength(1)

    // The external edit is the "switch API" surface: wait until the settings
    // provider publishes the new base URL, then the next request must reach
    // the new endpoint with the managed credential.
    await writeFile(settingsPath, `llm-opencode-go:\n  baseURL: ${JSON.stringify(second.url)}\n`)
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { baseURL?: string }).baseURL).toBe(second.url)
    }, { timeout: 10_000 })

    await assemble(ctx, { model: 'kimi-k3', messages: MESSAGES })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    expect(second.headers[0]?.authorization).toBe('Bearer boot-key')
  }, 30_000)
})
