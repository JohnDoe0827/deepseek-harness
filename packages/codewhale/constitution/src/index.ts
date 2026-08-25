/**
 * CodeWhale-style constitution for DeepSeek Harness: a workspace file
 * (`Config.file`, resolved against each session's working directory) declares
 * standing instructions injected into every model request and write holds
 * that reject workspace file mutations regardless of approval posture.
 *
 * The file is read and validated lazily on every use, so edits take effect at
 * the next write decision or request assembly with no reload command. A
 * missing file means no constitution; a malformed one fails the write
 * decision or the request assembly loudly instead of being ignored.
 *
 * Enforcement sits at the fs decision waterfalls (`fs/write-intent`,
 * `fs/edit-intent`) with `prepend: true`, so this policy runs before the
 * observation policy regardless of mount order and a held write throws
 * `FsError(FS_PERMISSION_DENIED)` from the same slot the tool pipeline
 * already maps for the model. Direct tool callers that dispatch those
 * waterfalls are covered; shell commands that write files are not (see the
 * README's Known Limitations).
 *
 * @module @deepseek-ai/dsh-codewhale-constitution
 */

import { Context } from '@deepseek-ai/cordis'
import { statSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { minimatch } from 'minimatch'
import { parse as parseYaml } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only edges: resolve ctx.systemPrompt, ctx.commands, and the
// AssembleContext.agent merge (the last comes from dsh-agent's declaration).
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'

export const name = 'codewhale-constitution'
export const inject = ['systemPrompt', 'fs']

/** Deployment-owned constitution file location. */
export interface Config {
  /**
   * Constitution file path, resolved against each session's working
   * directory; absolute paths are used as-is.
   */
  file: string
}

/** Schemastery configuration for the constitution plugin. */
export const Config: z<Config> = z.object({
  file: z.string().required(),
})

/** One parsed constitution document: standing instructions plus write holds. */
export interface ConstitutionDocument {
  /** Guidance injected as the `codewhale:constitution` prompt section. */
  readonly instructions: string
  /** Workspace-relative glob patterns whose matches reject writes. */
  readonly writeHolds: readonly string[]
}

/**
 * Validate the deployment config: a non-empty `file` and no unknown keys.
 * @param config - raw plugin config.
 * @returns the detached validated config.
 */
export function resolveConfig(config: Config): Config {
  if (typeof config.file !== 'string' || config.file.trim() === '') {
    throw new Error('ConstitutionConfig needs a non-empty string `file`')
  }
  const unknown = Object.keys(config).filter(key => key !== 'file')
  if (unknown.length > 0) {
    throw new Error(`ConstitutionConfig has unknown key(s) ${unknown.join(', ')} — config is { file }`)
  }
  return { file: config.file }
}

/**
 * Parse and validate a constitution file's YAML text. Empty documents are a
 * valid empty constitution; anything else must be a mapping whose known keys
 * carry their declared types. Unknown keys and malformed values fail loud.
 * @param text - the file's UTF-8 text.
 * @param source - the file path used in diagnostics.
 * @returns the validated document.
 */
export function parseConstitution(text: string, source: string): ConstitutionDocument {
  const raw: unknown = parseYaml(text)
  if (raw === null || raw === undefined) return { instructions: '', writeHolds: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`constitution ${source} must be a YAML mapping`)
  }
  const doc = raw as Record<string, unknown>
  const unknown = Object.keys(doc).filter(key => key !== 'instructions' && key !== 'writeHolds')
  if (unknown.length > 0) {
    throw new Error(`constitution ${source} has unknown key(s) ${unknown.join(', ')} — keys are { instructions, writeHolds }`)
  }
  const instructions = doc.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error(`constitution ${source} "instructions" must be a string`)
  }
  const holds = doc.writeHolds
  if (holds !== undefined) {
    if (!Array.isArray(holds) || holds.some(hold => typeof hold !== 'string' || hold.trim() === '')) {
      throw new Error(`constitution ${source} "writeHolds" must be an array of non-empty strings`)
    }
  }
  return {
    instructions: instructions ?? '',
    writeHolds: holds ?? [],
  }
}

/**
 * Express an absolute path relative to a workspace root with POSIX
 * separators, or `undefined` when the path lies outside the root.
 * @param workspace - the canonical workspace root.
 * @param absolute - the canonical absolute path to relativize.
 * @returns the relative POSIX path, or `undefined` for outside paths.
 */
export function relWorkspacePath(workspace: string, absolute: string): string | undefined {
  const rel = relative(workspace, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/**
 * The first write hold matching a workspace-relative path, or `undefined`.
 * @param relPath - the workspace-relative POSIX path.
 * @param holds - the constitution's write-hold globs.
 * @returns the matching pattern, or `undefined` when none matches.
 */
export function heldPattern(relPath: string, holds: readonly string[]): string | undefined {
  return holds.find(pattern => minimatch(relPath, pattern, { dot: true }))
}

/**
 * Register the constitution plugin: the `codewhale:constitution` prompt
 * section, the two fs decision waterfalls, and the `/constitution` command.
 * @param ctx - registrant context carrying the fs and system-prompt services.
 * @param config - deployment-owned constitution file location.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg = resolveConfig(config)
  const fs = ctx.fs
  // mtime-keyed parse cache per absolute constitution path: repeated reads in
  // one boot stay cheap while edits are picked up at the next use.
  const cache = new Map<string, { mtimeMs: number; doc: ConstitutionDocument | undefined }>()

  ctx.effect(() => () => {
    cache.clear()
  }, 'codewhale-constitution parse cache teardown')

  /**
   * The constitution in force for one session's workspace, or `undefined`
   * when the file is absent. Throws on unreadable or malformed files.
   */
  function documentFor(session: Session): ConstitutionDocument | undefined {
    const workspace = workspaceOf(session)
    if (workspace === undefined) return undefined
    const abs = isAbsolute(cfg.file) ? cfg.file : resolve(workspace, cfg.file)
    let mtimeMs: number
    try {
      mtimeMs = statSync(abs).mtimeMs
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const cached = cache.get(abs)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.doc
    const text = readFileSync(abs, 'utf8')
    const doc = parseConstitution(text, abs)
    cache.set(abs, { mtimeMs, doc })
    return doc
  }

  /** The agent session behind an opaque fs waterfall actor, if any. */
  function sessionOf(actor: object | undefined): Session | undefined {
    // tsgolint treats object as assignable to this weak structural type, while
    // tsc still requires the assertion for property access (same divergence as
    // dsh-fs-observation-policy's FsObservationActor cast).
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    return (actor as { agent?: { session?: Session } } | undefined)?.agent?.session
  }

  /**
   * Decide one fs write or edit: throw `FS_PERMISSION_DENIED` when the
   * target matches a write hold, otherwise delegate through `next()` so the
   * observation policy owns the guarded intent.
   */
  function decide<T>(
    target: FsTarget,
    actor: object | undefined,
    next: () => T | Promise<T>,
    operation: 'write' | 'edit',
  ): Promise<T> {
    const session = sessionOf(actor)
    if (session !== undefined) {
      const workspace = workspaceOf(session)
      if (workspace !== undefined) {
        const doc = documentFor(session)
        if (doc !== undefined && doc.writeHolds.length > 0) {
          const rel = relWorkspacePath(workspace, fs.processPath(target))
          const hold = rel !== undefined ? heldPattern(rel, doc.writeHolds) : undefined
          if (hold !== undefined) {
            return Promise.reject(new FsError(
              `constitution write hold "${hold}" blocks ${operation} of "${target.displayPath}"`,
              'FS_PERMISSION_DENIED',
            ))
          }
        }
      }
    }
    return Promise.resolve().then(() => next())
  }

  // prepend: the single-slot fs decision waterfalls run listeners in
  // registration order, and the base bundle's observation policy mounts
  // before this plugin; this listener must always be consulted first.
  ctx.on('fs/write-intent', (target, actor, next) => decide(target, actor, next, 'write'), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => decide(target, actor, next, 'edit'), { prepend: true })

  ctx.systemPrompt.section({
    name: 'codewhale:constitution',
    order: 60,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      const doc = documentFor(agent.session)
      if (doc === undefined) return ''
      const parts: string[] = []
      if (doc.instructions !== '') parts.push(doc.instructions)
      if (doc.writeHolds.length > 0) {
        parts.push(`Write holds (the harness rejects writes to these workspace paths regardless of approval posture): ${doc.writeHolds.join(', ')}`)
      }
      return parts.join('\n\n')
    },
  })

  // The command child activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'constitution',
      description: 'Show the active constitution file, standing instructions, and write holds',
      handler: ({ agent }) => {
        const workspace = workspaceOf(agent.session)
        const shown = workspace !== undefined && !isAbsolute(cfg.file)
          ? `${cfg.file} (in ${workspace})`
          : cfg.file
        const doc = documentFor(agent.session)
        if (doc === undefined) {
          return { kind: 'success', text: `Constitution ${shown}: file not found — no instructions or write holds in force.` }
        }
        const instructionChars = doc.instructions.length
        const holds = doc.writeHolds.length > 0 ? doc.writeHolds.join(', ') : 'none'
        return {
          kind: 'success',
          text: `Constitution ${shown}: ${instructionChars} instruction characters; write holds: ${holds}.`,
        }
      },
    })
  })
}

/** The workspace root one session's constitution resolves against. */
function workspaceOf(session: Session): string | undefined {
  return session.header.cwd ?? undefined
}
