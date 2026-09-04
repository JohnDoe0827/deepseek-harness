/**
 * Context-bloat handoff observer with automatic backup.
 *
 * Runs on its own clock (a `setInterval` independent of the agent timeline)
 * and measures each live session's token pressure with the token meter. When
 * `totalTokens` reaches `thresholdRatio * contextWindow` for the session's
 * routed model, it performs the handoff automatically: bundles the project
 * (`git bundle --all`), archives the working tree (tarball excluding build
 * and dependency residue), exports the conversation JSONL from the session
 * record, writes a `HANDOFF-<topic>.md` note, then appends a durable
 * `context/handoff` notice (carrying every artifact path) and injects a
 * model-visible reminder telling the user to open a fresh session. The
 * fresh session mounts this observer and `dsh-observer` with a bumped
 * `cycle` so the monitoring loop continues.
 *
 * The measure-then-notice ordering is a package invariant: every
 * `context/handoff` event's `totalTokens` must be at least its
 * `thresholdTokens`, so a notice is only ever written after a real pressure
 * measurement crossed the boundary. Backup failures are captured into the
 * notice's `error` field rather than suppressing the notice or throwing.
 *
 * @module @deepseek-ai/dsh-context-handoff
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
// Type-only edge: resolve ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'

const execFileAsync = promisify(execFile)

export const name = 'context-handoff'
export const inject = ['agents', 'llm', 'tokenMeter', 'agentDefaultModel']

/** Durable payload of one `context/handoff` event. */
export interface ContextHandoffNoticeData {
  /** Session name the routed model targets (provider/model key). */
  target: string
  /** Measured request-and-response pressure when the boundary crossed. */
  totalTokens: number
  /** Adapter-owned model capacity for the routed target. */
  contextWindow: number
  /** `floor(contextWindow * thresholdRatio)`: the boundary that tripped. */
  thresholdTokens: number
  /** Configured pressure fraction of the context window. */
  ratio: number
  /** Human-readable boundary fact, e.g. `612340 >= 600000 (0.6 of 1000000)`. */
  reason: string
  /** Handoff cycle number: 0 for the first session, incremented by the next session's config. */
  cycle: number
  /** Directory artifact backups were written to. */
  backupDir: string
  /** Full-history git bundle path, when the project is a git worktree. */
  bundlePath?: string
  /** Source tarball path (working tree minus excludes). */
  tarballPath?: string
  /** Exported conversation JSONL path (decompressed). */
  jsonlPath?: string
  /** Handoff note path written for the fresh session. */
  notePath: string
  /** Backup failure text; absent means every artifact landed. */
  error?: string
}

/** One automatic backup run: bundle + tarball + JSONL export + note path. */
export interface BackupArtifacts {
  bundlePath?: string
  tarballPath?: string
  jsonlPath?: string
  notePath: string
}

/** The deployable backup executor; tests may substitute an in-memory fake. */
export type BackupRunner = (opts: {
  backupDir: string
  projectDir: string
  topic: string
  excludePatterns: string[]
  sessionId: string
  /** Rendered handoff note the runner writes to `notePath`. */
  note: string
}) => Promise<BackupArtifacts>

/** Deployment-owned config: the pressure boundary plus backup destinations. */
export interface Config {
  /** Evaluate pressure on this cadence, in ms (default 10000). */
  tickMs?: number
  /** Fraction of the routed model's context window that trips a handoff (default 0.6). */
  thresholdRatio?: number
  /** Handoff cycle number; the fresh session config sets it one past the previous session's last notice (default 0). */
  cycle?: number
  /** Directory to write backups into (default `<homedir>/backups`). */
  backupDir?: string
  /** Project root whose working tree is archived (default `process.cwd()`). */
  projectDir?: string
  /** Topic used for artifact and handoff-note names (default derived from the session id). */
  topic?: string
  /** Tarball exclude patterns, each a tar `--exclude` pattern (default `.git`, `node_modules`, `lib`). */
  excludePatterns?: string[]
  /** Backup executor; defaults to the child-process implementation. Tests inject a fake. */
  backupRunner?: BackupRunner
}

export const Config: z<Config> = z.object({
  tickMs: z.number().default(10_000),
  thresholdRatio: z.number().default(0.6),
  cycle: z.number().default(0),
  backupDir: z.string(),
  projectDir: z.string(),
  topic: z.string(),
  excludePatterns: z.array(z.string()),
  backupRunner: z.function(),
})

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One context-bloat handoff notice. `target` names the routed model,
     * `totalTokens`/`contextWindow`/`thresholdTokens` the measured pressure
     * and its boundary, `ratio` the configured fraction, `reason` the
     * readable boundary fact, `cycle` the handoff generation, and the path
     * fields (`backupDir`, `bundlePath`, `tarballPath`, `jsonlPath`,
     * `notePath`) the artifacts the plugin wrote. `error` carries a backup
     * failure when one occurred.
     * @mode durable, model-visible adjacency: this event is the record of the
     * reminder the agent received.
     */
    'context/handoff': ContextHandoffNoticeData
  }
}

/** Per-session state: whether this session already performed a handoff. */
interface ObserverState {
  fired: boolean
}

/** Resolve the routed provider/model key for a session's default route. */
function targetKey(
  ctx: Context,
): { provider: string; model: string; key: string } {
  const route = ctx.agentDefaultModel.currentSelection()
  const provider = route.provider
  const model = route.model
  return { provider, model, key: `${provider}/${model}` }
}

/** Resolved plugin configuration: defaults applied, all fields concrete. */
type ResolvedConfig = {
  tickMs: number
  thresholdRatio: number
  cycle: number
  backupDir: string
  projectDir: string
  topic: string
  excludePatterns: string[]
  backupRunner: BackupRunner
}

/** The exported conversation record path, from the host environment when present. */
function sessionJsonlPath(): string | undefined {
  const value = process.env.DSH_SESSION_JSONL
  return value ?? undefined
}

/** Render the generated handoff note for the fresh session. */
function renderHandoffNote(input: {
  topic: string
  cycle: number
  projectDir: string
  backupDir: string
  bundlePath: string | undefined
  tarballPath: string | undefined
  jsonlPath: string | undefined
  notePath: string
  sessionId: string
  target: string
  thresholdTokens: number
}): string {
  const artifacts = [
    input.bundlePath === undefined ? '' : `- \`${input.bundlePath}\` — 全历史 git bundle（clone 即可恢复）`,
    input.tarballPath === undefined ? '' : `- \`${input.tarballPath}\` — 源码归档（不含 .git/node_modules/lib）`,
    input.jsonlPath === undefined ? '' : `- \`${input.jsonlPath}\` — 完整对话记录（明文 JSONL）`,
  ].filter(Boolean).join('\n')
  return [
    '# HANDOFF — <补一句目标>',
    '',
    `> 由 @deepseek-ai/dsh-context-handoff 自动生成（cycle ${input.cycle}），会话 ${input.sessionId}。`,
    `> 新会话恢复监控：挂载 @deepseek-ai/dsh-observer 与 @deepseek-ai/dsh-context-handoff，后者 config cycle = ${input.cycle + 1}、`,
    `> projectDir: ${input.projectDir}、backupDir: ${input.backupDir}、thresholdRatio 不变。`,
    '',
    '## 已交付成果',
    '',
    '<!-- 填写本会话完成的提交（hash + 内容），随后续会话核对 git log -->',
    '',
    '## 关键文件',
    '',
    '<!-- 填写后续会话最先要打开的文件路径 -->',
    '',
    '## 仓库状态',
    '',
    '<!-- 分支、remote、未提交改动（哪些勿提交）、untracked 垃圾 -->',
    '',
    '## 备份',
    '',
    artifacts,
    '',
    '- `' + input.notePath + '` — 本交接文档',
    '',
    '## 若继续（可选下一步）',
    '',
    '<!-- 编号的、具体的下一步 -->',
    '',
    '## 环境备注',
    '',
    `- 项目目录：\`${input.projectDir}\``,
    `- 备份目录：\`${input.backupDir}\``,
    `- 触发时压力：${input.thresholdTokens} tokens（0.6 of ${input.target} context window）`,
  ].join('\n')
}

/** The default backup executor: child-process git bundle + tarball + JSONL export + handoff note. */
export const defaultBackupRunner: BackupRunner = async (opts) => {
  await mkdir(opts.backupDir, { recursive: true })
  const bundlePath = join(opts.backupDir, `${opts.topic}.bundle`)
  const tarballPath = join(opts.backupDir, `${opts.topic}-src.tar.gz`)
  const notePath = join(opts.backupDir, `HANDOFF-${opts.topic}.md`)
  const jsonlSource = sessionJsonlPath()
  const jsonlPath = jsonlSource === undefined
    ? undefined
    : join(opts.backupDir, `${opts.topic}-conversation.jsonl`)

  // Full-history git bundle when the project is a git worktree; the parent
  // .git absence is not fatal — the tarball still preserves the tree.
  let bundleError: string | undefined
  try {
    await execFileAsync('git', ['bundle', 'create', bundlePath, '--all'], { cwd: opts.projectDir })
  } catch (error) {
    bundleError = error instanceof Error ? error.message : String(error)
  }

  // Source tarball: the working tree minus build/dependency residue.
  const excludes = opts.excludePatterns.map(pattern => `--exclude=${pattern}`)
  await execFileAsync('tar', ['-czf', tarballPath, ...excludes, opts.projectDir], { cwd: dirname(opts.projectDir) })

  // Export the conversation JSONL when the host exposed its record path.
  if (jsonlSource !== undefined && jsonlPath !== undefined) {
    await copyFile(jsonlSource, jsonlPath)
  }

  if (bundleError !== undefined && jsonlPath === undefined) {
    // The bundle failed and there is no JSONL to fall back on; surface it.
    throw new Error(`git bundle failed: ${bundleError}`)
  }

  await writeFile(notePath, opts.note)

  return {
    ...bundleError === undefined ? { bundlePath } : {},
    tarballPath,
    ...jsonlPath === undefined ? {} : { jsonlPath },
    notePath,
  }
}

/**
 * Register the context-handoff observer: a clock that measures live session
 * pressure and, past the threshold, backs the project and conversation up
 * automatically, writes the handoff note, records the durable notice, and
 * injects the fresh-session reminder.
 * @param ctx - registrant context with token meter, llm, and the agent registry.
 * @param config - deployment-owned handoff threshold and backup config.
 */
export function apply(ctx: Context, config: Config): void {
  const cfg: ResolvedConfig = {
    tickMs: config.tickMs ?? 10_000,
    thresholdRatio: config.thresholdRatio ?? 0.6,
    cycle: config.cycle ?? 0,
    backupDir: config.backupDir ?? join(homedir(), 'backups'),
    projectDir: config.projectDir ?? process.cwd(),
    topic: config.topic ?? 'session-handoff',
    excludePatterns: config.excludePatterns ?? ['.git', 'node_modules', 'lib'],
    backupRunner: config.backupRunner ?? defaultBackupRunner,
  }
  ctx.effect(function* () {
    const states = new WeakMap<Session, ObserverState>()
    // Model capacity is a per-target constant; resolve once and reuse.
    const windows = new Map<string, { window: number; threshold: number }>()

    function stateFor(session: Session): ObserverState {
      let state = states.get(session)
      if (state === undefined) {
        state = { fired: false }
        states.set(session, state)
      }
      return state
    }

    ctx.on('agent/created', ({ agent }) => {
      stateFor(agent.session)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent.session)
    })

    const timer = setInterval(() => {
      const agents = ctx.agents.list()
      for (const agent of agents) {
        const session = agent.session
        const state = stateFor(session)
        if (state.fired) continue
        const measurement: TokenMeasurement = ctx.tokenMeter.measure(session)
        if (measurement.totalTokens === 0) continue
        const { provider, model, key } = targetKey(ctx)
        const cap = windows.get(key)
        if (cap === undefined) {
          void ctx.llm.resolveModelInfo(provider, model, new AbortController().signal).then((info) => {
            const window = info.context?.contextWindow
            if (window === undefined || window <= 0) return
            const threshold = Math.floor(window * cfg.thresholdRatio)
            windows.set(key, { window, threshold })
            void check(agent, state, measurement, key, window, threshold, cfg)
          }).catch(() => { /* a transient model-info failure defers to the next tick */ })
          continue
        }
        void check(agent, state, measurement, key, cap.window, cap.threshold, cfg)
      }
    }, cfg.tickMs)

    yield () => { clearInterval(timer) }
  })
}

/**
 * Measure-then-handoff: fire only when the measurement provably crossed the
 * boundary, then run the automatic backup (bundle, tarball, JSONL export,
 * handoff note), append the durable notice carrying every artifact path, and
 * inject the fresh-session reminder.
 */
async function check(
  agent: Agent,
  state: ObserverState,
  measurement: TokenMeasurement,
  key: string,
  window: number,
  threshold: number,
  cfg: ResolvedConfig,
): Promise<void> {
  if (state.fired || measurement.totalTokens < threshold) return
  state.fired = true
  const reason = `${measurement.totalTokens} >= ${threshold} (${cfg.thresholdRatio} of ${window})`
  const sessionId = agent.session.id
  const topic = cfg.topic === 'session-handoff' ? `session-${sessionId}` : cfg.topic
  const notePath = join(cfg.backupDir, `HANDOFF-${topic}.md`)
  const bundlePath = join(cfg.backupDir, `${topic}.bundle`)
  const tarballPath = join(cfg.backupDir, `${topic}-src.tar.gz`)
  const jsonlSource = sessionJsonlPath()
  const jsonlPath = jsonlSource === undefined
    ? undefined
    : join(cfg.backupDir, `${topic}-conversation.jsonl`)

  let artifacts: BackupArtifacts
  let error: string | undefined
  try {
    artifacts = await cfg.backupRunner({
      backupDir: cfg.backupDir,
      projectDir: cfg.projectDir,
      topic,
      excludePatterns: cfg.excludePatterns,
      sessionId,
      note: renderHandoffNote({
        topic,
        cycle: cfg.cycle,
        projectDir: cfg.projectDir,
        backupDir: cfg.backupDir,
        bundlePath,
        tarballPath,
        jsonlPath,
        notePath,
        sessionId,
        target: key,
        thresholdTokens: threshold,
      }),
    })
  } catch (backupError) {
    artifacts = { notePath }
    error = backupError instanceof Error ? backupError.message : String(backupError)
  }

  agent.session.append('context/handoff', {
    target: key,
    totalTokens: measurement.totalTokens,
    contextWindow: window,
    thresholdTokens: threshold,
    ratio: cfg.thresholdRatio,
    reason,
    cycle: cfg.cycle,
    backupDir: cfg.backupDir,
    notePath: artifacts.notePath,
    ...artifacts.bundlePath === undefined ? {} : { bundlePath: artifacts.bundlePath },
    ...artifacts.tarballPath === undefined ? {} : { tarballPath: artifacts.tarballPath },
    ...artifacts.jsonlPath === undefined ? {} : { jsonlPath: artifacts.jsonlPath },
    ...error === undefined ? {} : { error },
  })

  const nextCycle = cfg.cycle + 1
  const summary = error === undefined
    ? `Backup complete: ${artifacts.bundlePath ?? 'no bundle'}, ${artifacts.tarballPath ?? 'no tarball'}, `
      + `${artifacts.jsonlPath ?? 'no jsonl'}, note ${artifacts.notePath}.`
    : `Backup failed: ${error}. Fix and run the dsh-context-handoff skill manually.`
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: `Context bloat detected (handoff cycle ${cfg.cycle}): session pressure ${measurement.totalTokens} tokens reached the `
        + `handoff threshold ${threshold} (${cfg.thresholdRatio} of ${window} window for ${key}). ${summary} `
        + 'Tell the user to open a fresh session; the fresh session must mount this observer and the dsh-observer guard with '
        + `cycle = ${nextCycle} so the monitoring loop continues.`,
    }],
    source: {
      kind: 'plugin',
      plugin: 'context-handoff',
      form: 'notice',
      summary: `context handoff @${threshold}`,
    },
  })
  agent.inject(message)
}
