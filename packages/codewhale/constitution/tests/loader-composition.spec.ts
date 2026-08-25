// Real-Loader composition for the constitution plugin: a cordis.yml mounts
// the plugin beside the system-prompt and command registries plus a stub fs
// service, and the tests drive the exact dispatch points the tool pipeline
// uses — `fs/write-intent` and `fs/edit-intent` waterfalls — plus the prompt
// assembly and the `/constitution` command.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import * as Constitution from '@deepseek-ai/dsh-codewhale-constitution'

let root: string | undefined
let workspace: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  workspace = undefined
})

/**
 * Boot a cordis.yml mounting the constitution plugin plus the registries it
 * consumes, with `ctx.fs` provided by a stub whose process paths are the
 * targets' display paths.
 * @param file - the constitution file name, resolved against the temp workspace.
 */
async function boot(file: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-constitution-loader-'))
  workspace = join(root, 'ws')
  await mkdir(workspace, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-codewhale-constitution'",
    '  config:',
    `    file: ${file}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-commands', CommandRegistry],
    ['@deepseek-ai/dsh-codewhale-constitution', Constitution],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // Stub fs: process paths are the display paths (absolute in these tests).
  ctx.provide('fs', { processPath: (target: FsTarget) => target.displayPath })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** A session whose workspace root is the temp workspace. */
function session(id = 'constitution-session'): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd: workspace!,
  })
}

/** A minimal agent carrying that session (assembly and command surfaces). */
function agent(session: Session): Agent {
  return { id: session.id, options: {}, session } as unknown as Agent
}

/** One fs target inside the temp workspace. */
function target(rel: string): FsTarget {
  return { targetKey: FsTargetKey(rel), displayPath: join(workspace!, rel) }
}

/** The actor the tool pipeline passes to the fs waterfalls: an agent session. */
function actor(session: Session): object {
  return { agent: { session } }
}

describe('codewhale-constitution real Loader composition', () => {
  it('rejects a held write with FS_PERMISSION_DENIED and delegates allowed writes', async () => {
    const ctx = await boot('codewhale.constitution.yml')
    await writeFile(join(workspace!, 'codewhale.constitution.yml'), [
      'writeHolds:',
      '  - "**/secrets/**"',
      '  - package-lock.json',
    ].join('\n'))
    const owner = session()

    await expect(ctx.waterfall('fs/write-intent', target('src/secrets/key.yml'), actor(owner), () => undefined))
      .rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
    await expect(ctx.waterfall('fs/edit-intent', target('package-lock.json'), actor(owner), () => undefined))
      .rejects.toSatisfy((error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED')

    // Allowed paths delegate: the observation-policy slot (here the next
    // callback) owns the guarded intent.
    const intent = { kind: 'replaceIfVersion', version: FsVersion('7') } as const
    await expect(ctx.waterfall('fs/write-intent', target('src/app.ts'), actor(owner), () => intent))
      .resolves.toBe(intent)
    // Outside the workspace no hold applies and delegation still happens.
    const outside = { targetKey: FsTargetKey('outside'), displayPath: join(root!, '..', 'other', 'f.ts') }
    await expect(ctx.waterfall('fs/write-intent', outside, actor(owner), () => intent))
      .resolves.toBe(intent)
  }, 30_000)

  it('delegates every write when the constitution file is absent or the actor has no session', async () => {
    const ctx = await boot('missing.yml')
    const owner = session()
    const intent = { kind: 'createIfAbsent' } as const
    await expect(ctx.waterfall('fs/write-intent', target('src/app.ts'), actor(owner), () => intent))
      .resolves.toBe(intent)
    await expect(ctx.waterfall('fs/write-intent', target('src/app.ts'), undefined, () => intent))
      .resolves.toBe(intent)
  }, 30_000)

  it('renders instructions and holds into the prompt section only for a session', async () => {
    const ctx = await boot('c.yml')
    await writeFile(join(workspace!, 'c.yml'), [
      'instructions: Always run the tests before finishing.',
      'writeHolds:',
      '  - "**/secrets/**"',
    ].join('\n'))
    const owner = session()

    const withAgent = await ctx.systemPrompt.assemble({ agent: agent(owner) })
    const section = withAgent.sections.find(s => s.name === 'codewhale:constitution')
    expect(section?.text).toContain('Always run the tests before finishing.')
    expect(section?.text).toContain('**/secrets/**')

    const withoutAgent = await ctx.systemPrompt.assemble()
    expect(withoutAgent.sections.find(s => s.name === 'codewhale:constitution')?.text).toBe('')
  }, 30_000)

  it('serves the /constitution command', async () => {
    const ctx = await boot('c.yml')
    await writeFile(join(workspace!, 'c.yml'), 'writeHolds:\n  - package-lock.json\n')
    const owner = session()
    const execution = await ctx.commands.execute(agent(owner), '/constitution', new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text?: string }).text).toContain('package-lock.json')
    expect((execution?.result as { text?: string }).text).toContain('c.yml')
  }, 30_000)

  it('stops enforcing after disposal (HMR safety)', async () => {
    const ctx = await boot('c.yml')
    await writeFile(join(workspace!, 'c.yml'), 'writeHolds:\n  - package-lock.json\n')
    const owner = session()
    await ctx.fiber.dispose()
    context = undefined
    // A disposed tree dispatches nothing: the waterfall yields no promise and
    // the held path is no longer consulted.
    const result = await ctx.waterfall('fs/write-intent', target('package-lock.json'), actor(owner), () => undefined)
    expect(result).toBeUndefined()
  }, 30_000)
})
