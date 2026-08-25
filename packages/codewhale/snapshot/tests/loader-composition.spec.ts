// Real-Loader composition for the snapshot plugin: a cordis.yml mounts the
// plugin beside the command registry, and the tests drive the exact surfaces
// users hit — `turn/end` session events taking snapshots and `/undo` /
// `/restore` commands rolling the workspace back.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import * as Snapshot from '@deepseek-ai/dsh-codewhale-snapshot'

let root: string | undefined
let workspace: string | undefined
let store: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  workspace = undefined
  store = undefined
})

/** Boot a cordis.yml mounting the snapshot plugin with a temp store. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-loader-'))
  workspace = join(root, 'ws')
  store = join(root, 'snapshots')
  await mkdir(workspace, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-codewhale-snapshot'",
    '  config:',
    `    dir: ${store}`,
    '    excludes:',
    '      - node_modules',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-commands', CommandRegistry],
    ['@deepseek-ai/dsh-codewhale-snapshot', Snapshot],
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
  return ctx
}

/** An agent whose session lives in the temp workspace. */
function agent(id = 'snapshot-session'): Agent & { session: Session; inject: Mock<(message: UserMessage) => void> } {
  const session = Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd: workspace!,
  })
  const inject = vi.fn<(message: UserMessage) => void>()
  const value = {
    id: session.id, options: {}, session,
    inject: inject as unknown as Agent['inject'],
  } as unknown as Agent
  return Object.assign(value, { inject })
}

/** Dispatch a `turn/end` session event exactly as the loop broadcasts it. */
async function endTurn(ctx: Context, agent: Agent & { session: Session }, turn: number): Promise<void> {
  ctx.emit('session/event', agent.session, {
    type: 'turn/end',
    seq: turn * 2,
    time: turn * 2,
    data: { turn, reason: { kind: 'completed' } },
  })
  // The snapshot runs asynchronously after the emit; meta.json is written
  // last, so its presence proves the copy finished. An unchanged turn takes
  // no snapshot — the store then simply stops changing across a poll cycle.
  // vi.waitFor resolves on a non-throwing callback, so incomplete states
  // throw to keep it polling.
  await vi.waitFor(async () => {
    const dir = join(store!, String(agent.session.id))
    const seqs = await Snapshot.snapshotSeqDirs(dir)
    if (seqs.length === 0) throw new Error('snapshot store empty')
    const latest = seqs.at(-1)!
    const meta = JSON.parse(
      await readFile(join(dir, String(latest), 'meta.json'), 'utf8'),
    ) as { turn: number }
    if (meta.turn === turn) return true
    await new Promise(resolve => setTimeout(resolve, 50))
    const later = await Snapshot.snapshotSeqDirs(dir)
    if (later.length !== seqs.length) throw new Error('snapshot still in flight')
    return true
  }, { timeout: 10_000 })
}

describe('codewhale-snapshot real Loader composition', () => {
  it('snapshots changed turns and skips unchanged ones', async () => {
    const ctx = await boot()
    const owner = agent()
    await writeFile(join(workspace!, 'a.txt'), 'v1')

    await endTurn(ctx, owner, 1)
    let seqs = await Snapshot.snapshotSeqDirs(join(store!, String(owner.session.id)))
    expect(seqs).toEqual([1])
    expect(await readFile(join(store!, String(owner.session.id), '1', 'a.txt'), 'utf8')).toBe('v1')

    // Unchanged turn: no new snapshot, and no snapshot/taken event.
    await endTurn(ctx, owner, 2)
    seqs = await Snapshot.snapshotSeqDirs(join(store!, String(owner.session.id)))
    expect(seqs).toEqual([1])
    expect(owner.session.events.filter(e => e.type === 'snapshot/taken')).toHaveLength(1)
  }, 30_000)

  it('/undo restores the state before the latest change and announces it', async () => {
    const ctx = await boot()
    const owner = agent()
    await writeFile(join(workspace!, 'a.txt'), 'v1')
    await endTurn(ctx, owner, 1)

    await writeFile(join(workspace!, 'a.txt'), 'v2')
    await writeFile(join(workspace!, 'b.txt'), 'new')
    await endTurn(ctx, owner, 2)

    expect(await readFile(join(workspace!, 'a.txt'), 'utf8')).toBe('v2')
    const execution = await ctx.commands.execute(owner, '/undo', new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(await readFile(join(workspace!, 'a.txt'), 'utf8')).toBe('v1')
    const restoreEvents = owner.session.events.filter(e => e.type === 'snapshot/restore')
    expect(restoreEvents).toHaveLength(1)
    expect(restoreEvents[0]?.data).toEqual({ seq: 1, turn: 1 })
    expect(owner.inject).toHaveBeenCalledOnce()
  }, 30_000)

  it('/restore lists snapshots and restores a named one', async () => {
    const ctx = await boot()
    const owner = agent()
    await writeFile(join(workspace!, 'a.txt'), 'v1')
    await endTurn(ctx, owner, 1)
    await writeFile(join(workspace!, 'a.txt'), 'v2')
    await endTurn(ctx, owner, 2)

    const list = await ctx.commands.execute(owner, '/restore', new AbortController().signal)
    expect((list?.result as { text?: string }).text).toContain('#1')
    expect((list?.result as { text?: string }).text).toContain('#2')

    await writeFile(join(workspace!, 'a.txt'), 'v3')
    const restored = await ctx.commands.execute(owner, '/restore 1', new AbortController().signal)
    expect(restored?.result.kind).toBe('success')
    expect(await readFile(join(workspace!, 'a.txt'), 'utf8')).toBe('v1')

    const bad = await ctx.commands.execute(owner, '/restore 99', new AbortController().signal)
    expect(bad?.result.kind).toBe('error')
  }, 30_000)

  it('stops taking snapshots after disposal (HMR safety)', async () => {
    const ctx = await boot()
    const owner = agent()
    await writeFile(join(workspace!, 'a.txt'), 'v1')
    await endTurn(ctx, owner, 1)
    await ctx.fiber.dispose()
    context = undefined
    await writeFile(join(workspace!, 'a.txt'), 'v2')
    ctx.emit('session/event', owner.session, {
      type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'completed' } },
    })
    const seqs = await Snapshot.snapshotSeqDirs(join(store!, String(owner.session.id)))
    expect(seqs).toEqual([1])
  }, 30_000)
})
