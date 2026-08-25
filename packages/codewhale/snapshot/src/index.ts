/**
 * CodeWhale-style turn snapshots for DeepSeek Harness: after each turn the
 * plugin copies the session's workspace (minus `Config.excludes`) into
 * `Config.dir/<sessionId>/<seq>/` when its content fingerprint changed, and
 * the `/undo` and `/restore` commands roll the workspace back to an earlier
 * snapshot. Restores are durable `snapshot/restore` events and the restored
 * state is announced to the agent through an injected notice, so the model
 * never works against a workspace it was not told about.
 *
 * A snapshot is a full copy, so `undo`/`restore` are exact regardless of
 * intervening edits; the fingerprint skip keeps unchanged turns from growing
 * the store. Snapshots are taken asynchronously after `turn/end`, one
 * in-flight snapshot per session. Workspace files created or changed outside
 * the snapshot copy (shell commands, editors) are captured at the next turn
 * boundary like any other change.
 *
 * @module @deepseek-ai/dsh-codewhale-snapshot
 */

import { Context } from '@deepseek-ai/cordis'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only edges: resolve ctx.commands for the optional command child.
import type {} from '@deepseek-ai/dsh-commands'

export const name = 'codewhale-snapshot'

/** Deployment-owned snapshot store configuration. */
export interface Config {
  /**
   * Absolute snapshot store root; per-session copies live under
   * `<dir>/<sessionId>/<seq>/`.
   */
  dir: string
  /**
   * Workspace entries to skip: an entry is excluded when any path segment
   * equals an entry, or the relative path starts with `<entry>/`.
   */
  excludes: string[]
  /**
   * Optional workspace root override; default is each session's working
   * directory (`SessionHeader.cwd`), falling back to the process cwd.
   */
  workspace?: string
}

/** Schemastery configuration for the snapshot plugin. */
export const Config: z<Config> = z.object({
  dir: z.string().required(),
  excludes: z.array(z.string()).required(),
  workspace: z.string(),
})

/** One regular workspace file in a snapshot walk. */
export interface SnapshotFile {
  /** Workspace-relative path with POSIX separators. */
  readonly path: string
  /** File mtime in epoch milliseconds. */
  readonly mtimeMs: number
  /** File size in bytes. */
  readonly size: number
}

/** The metadata sidecar every snapshot directory carries. */
export interface SnapshotMeta {
  readonly seq: number
  readonly turn: number
  readonly createdAt: number
  readonly files: readonly SnapshotFile[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A workspace snapshot was taken after `turn/end`. Log-only UI state;
     * replay reconstructs the snapshot store layout, not file contents.
     */
    'snapshot/taken': { seq: number; turn: number; files: number }
    /**
     * The workspace was restored from snapshot `seq` (whose source turn was
     * `turn`, or `null` for a pre-turn baseline that later versions may
     * introduce). The restore itself is announced to the model through the
     * injected notice, which is the logged user/message that carries the
     * model-visible fact.
     */
    'snapshot/restore': { seq: number; turn: number | null }
  }
}

/**
 * Validate the deployment config: a non-empty absolute `dir`, non-empty
 * `excludes` entries, and no unknown keys.
 * @param config - raw plugin config.
 * @returns the detached validated config.
 */
export function resolveConfig(config: Config): Config {
  if (typeof config.dir !== 'string' || config.dir.trim() === '') {
    throw new Error('SnapshotConfig needs a non-empty string `dir`')
  }
  if (!Array.isArray(config.excludes) || config.excludes.some(ex => typeof ex !== 'string' || ex.trim() === '')) {
    throw new Error('SnapshotConfig `excludes` must be an array of non-empty strings')
  }
  if (config.workspace !== undefined && (typeof config.workspace !== 'string' || config.workspace.trim() === '')) {
    throw new Error('SnapshotConfig `workspace` must be a non-empty string when set')
  }
  const unknown = Object.keys(config).filter(key => key !== 'dir' && key !== 'excludes' && key !== 'workspace')
  if (unknown.length > 0) {
    throw new Error(`SnapshotConfig has unknown key(s) ${unknown.join(', ')} — config is { dir, excludes, workspace? }`)
  }
  return {
    dir: resolve(config.dir),
    excludes: [...config.excludes],
    ...config.workspace === undefined ? {} : { workspace: resolve(config.workspace) },
  }
}

/**
 * Whether a workspace-relative path is excluded: any path segment equals an
 * exclude entry, or the path starts with `<entry>/`.
 * @param relPath - workspace-relative POSIX path.
 * @param excludes - configured exclusion entries.
 * @returns true when the path must not be snapshotted.
 */
export function excludedPath(relPath: string, excludes: readonly string[]): boolean {
  const segments = relPath.split('/')
  return excludes.some(ex => segments.includes(ex) || relPath.startsWith(ex + '/'))
}

/**
 * The existing snapshot sequence numbers for one session's store, ascending.
 * @param sessionDir - the session's snapshot store directory.
 * @returns the numeric sequence numbers present, or an empty array.
 */
export async function snapshotSeqDirs(sessionDir: string): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir(sessionDir)
  } catch {
    return []
  }
  const seqs = entries
    .filter(entry => /^\d+$/.test(entry))
    .map(entry => Number(entry))
    .filter(seq => Number.isSafeInteger(seq) && seq >= 0)
  seqs.sort((a, b) => a - b)
  return seqs
}

/**
 * Walk a workspace and collect its regular files in stable (sorted) order,
 * skipping excluded entries and symbolic links.
 * @param workspace - the workspace root to walk.
 * @param excludes - configured exclusion entries.
 * @returns the collected files.
 */
export async function collectWorkspaceFiles(workspace: string, excludes: readonly string[]): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = relative(workspace, join(dir, entry.name)).split(sep).join('/')
      if (excludedPath(rel, excludes)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        const info = await stat(abs)
        files.push({ path: rel, mtimeMs: info.mtimeMs, size: info.size })
      }
      // Symbolic links and special files are skipped: links may cycle and
      // special files carry no portable content copy.
    }
  }
  await walk(workspace)
  return files
}

/**
 * Whether two snapshots' file inventories describe the same workspace state.
 * @param a - one inventory.
 * @param b - the other.
 * @returns true when paths, mtimes, and sizes all agree.
 */
export function fingerprintsEqual(a: readonly SnapshotFile[], b: readonly SnapshotFile[]): boolean {
  if (a.length !== b.length) return false
  return a.every((file, index) => {
    const other = b[index]
    return other !== undefined
      && other.path === file.path
      && other.mtimeMs === file.mtimeMs
      && other.size === file.size
  })
}

/** The workspace root one session's snapshots cover. */
function workspaceOf(cfg: Config, session: Session): string {
  return cfg.workspace !== undefined ? cfg.workspace : (session.header.cwd ?? process.cwd())
}

/** Read a snapshot's metadata sidecar. */
async function readMeta(seqDir: string): Promise<SnapshotMeta> {
  const parsed: unknown = JSON.parse(await readFile(join(seqDir, 'meta.json'), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`snapshot ${seqDir} has no meta.json`)
  const meta = parsed as Partial<SnapshotMeta>
  if (typeof meta.seq !== 'number' || typeof meta.turn !== 'number'
    || typeof meta.createdAt !== 'number' || !Array.isArray(meta.files)) {
    throw new Error(`snapshot ${seqDir} meta.json is malformed`)
  }
  return { seq: meta.seq, turn: meta.turn, createdAt: meta.createdAt, files: meta.files }
}

/**
 * Register the snapshot plugin: the `turn/end` snapshot hook and the
 * `/undo` and `/restore` commands.
 * @param ctx - registrant context.
 * @param config - deployment-owned snapshot store configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = resolveConfig(config)
  // One in-flight snapshot per session id: `session/event` is a firehose, and
  // a second turn/end while the first copy still runs must not double-write.
  const inFlight = new Map<string, Promise<void>>()

  ctx.effect(() => () => {
    inFlight.clear()
  }, 'codewhale-snapshot in-flight teardown')

  /** The snapshot store directory for one session. */
  function sessionDir(session: Session): string {
    return join(cfg.dir, String(session.id))
  }

  /**
   * Take a snapshot of one session's workspace after a turn, unless the
   * content fingerprint is unchanged since the latest snapshot.
   * @param session - the session whose turn ended.
   * @param turn - the turn that just ended.
   */
  async function take(session: Session, turn: number): Promise<void> {
    const workspace = workspaceOf(cfg, session)
    if (!(await stat(workspace).catch(() => undefined))?.isDirectory()) return
    const files = await collectWorkspaceFiles(workspace, cfg.excludes)
    const seqs = await snapshotSeqDirs(sessionDir(session))
    const latestSeq = seqs.at(-1)
    const latest = latestSeq !== undefined ? await readMeta(join(sessionDir(session), String(latestSeq))) : undefined
    if (latest !== undefined && fingerprintsEqual(latest.files, files)) return
    const seq = (latestSeq ?? 0) + 1
    const seqDir = join(sessionDir(session), String(seq))
    await mkdir(seqDir, { recursive: true })
    for (const file of files) {
      const dest = join(seqDir, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(join(workspace, file.path), dest)
    }
    const meta: SnapshotMeta = { seq, turn, createdAt: Date.now(), files }
    await writeFile(join(seqDir, 'meta.json'), JSON.stringify(meta, null, 2))
    session.append('snapshot/taken', { seq, turn, files: files.length })
  }

  /**
   * Restore one session's workspace from a snapshot.
   * @param session - the session owning the workspace.
   * @param seq - the snapshot sequence to restore.
   * @returns the restored snapshot's metadata.
   */
  async function restore(session: Session, seq: number): Promise<SnapshotMeta> {
    const seqDir = join(sessionDir(session), String(seq))
    const meta = await readMeta(seqDir).catch((error: unknown) => {
      throw new Error(`snapshot ${seq} does not exist for this session`, { cause: error })
    })
    const workspace = workspaceOf(cfg, session)
    for (const file of meta.files) {
      const dest = join(workspace, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(join(seqDir, file.path), dest)
    }
    return meta
  }

  /** Restore, log the durable event, and announce the restore to the model. */
  async function restoreAndAnnounce(agent: Agent, seq: number): Promise<SnapshotMeta> {
    const session = agent.session
    const meta = await restore(session, seq)
    session.append('snapshot/restore', { seq, turn: meta.turn })
    const text = `The workspace was restored to snapshot ${seq} (taken after turn ${meta.turn}).`
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'codewhale-snapshot', form: 'notice', summary: text },
    }))
    return meta
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const key = String(session.id)
    if (inFlight.has(key)) return
    const task = take(session, event.data.turn).catch((error: unknown) => {
      ctx.logger.warn('codewhale-snapshot: snapshot after turn failed: %o', error)
    })
    inFlight.set(key, task)
    void task.finally(() => inFlight.delete(key))
  })

  // The command child activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'undo',
      description: 'Restore the workspace to the snapshot before the latest change',
      handler: async ({ agent }) => {
        const seqs = await snapshotSeqDirs(sessionDir(agent.session))
        const target = seqs.at(-2)
        if (target === undefined) {
          return { kind: 'error', text: 'Nothing to undo: no earlier snapshot for this session.' }
        }
        try {
          const meta = await restoreAndAnnounce(agent, target)
          return { kind: 'success', text: `Restored the workspace to snapshot ${meta.seq} (after turn ${meta.turn}).` }
        } catch (error: unknown) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    commandCtx.commands.register({
      name: 'restore',
      description: 'List workspace snapshots, or restore one by sequence number',
      input: { hint: '[<seq>]' },
      handler: async ({ agent, rawInput }) => {
        const wanted = rawInput.trim()
        if (wanted !== '') {
          const seq = Number(wanted)
          if (!Number.isSafeInteger(seq) || seq <= 0) {
            return { kind: 'error', text: `Invalid snapshot sequence "${wanted}".` }
          }
          try {
            const meta = await restoreAndAnnounce(agent, seq)
            return { kind: 'success', text: `Restored the workspace to snapshot ${meta.seq} (after turn ${meta.turn}).` }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        }
        const seqs = await snapshotSeqDirs(sessionDir(agent.session))
        if (seqs.length === 0) {
          return { kind: 'success', text: 'No snapshots for this session yet.' }
        }
        const lines: string[] = ['Snapshots for this session:']
        for (const seq of seqs) {
          const meta = await readMeta(join(sessionDir(agent.session), String(seq)))
          const when = new Date(meta.createdAt).toISOString()
          lines.push(`#${meta.seq} · after turn ${meta.turn} · ${meta.files.length} files · ${when}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })
}
