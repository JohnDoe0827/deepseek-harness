/**
 * The TUI app's command-line provider: it parses the `dsh --profile tui` flag
 * family (`--resume`) and its `--help` text, then provides the launcher-owned
 * session identity, the disposable query-index path, the goodbye line, and the
 * in-place resume handoff through the {@link TUI_STARTUP_SERVICE} service and
 * the boot slots `@deepseek-ai/dsh-tui` reads. Ordinary rows inject the service
 * before reading it from lazy config, so Loader resolves their expressions only
 * after this provider exists.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import {
  CONFIGURED_AGENT_IDENTITIES_KEY,
  type LauncherAgentIdentity,
} from '@deepseek-ai/dsh-agent-loop'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_QUERY_SQLITE_PATH_KEY } from '@deepseek-ai/dsh-session-query-sqlite'
import type { TuiResumeHost } from '@deepseek-ai/dsh-tui'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the tui rows read from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Exact session id this process drives; fresh when `--resume` was absent. */
  sessionId: SessionId
  /** The resumed session id when `--resume <id>` named one. */
  resumeSessionId?: string
  /** Absolute path of this process's disposable derived query index. */
  sessionQueryPath: string
}

/** The tui flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
}

/** Boot-context keys `@deepseek-ai/dsh-tui` reads for launcher-owned values. */
const TUI_GOODBYE_MESSAGE_KEY = 'tuiGoodbyeMessage'
const TUI_RESUME_HOST_KEY = 'tuiResumeHost'

/** The configured agent id the tui surface drives. */
const MAIN_AGENT_ID = 'main'

/** Per-process filename of the disposable `/resume` index. */
const SESSION_QUERY_DB = `session-query-${String(process.pid)}-${randomUUID()}.db`

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run the interactive full-screen DeepSeek Harness TUI in the invoking directory.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <id>', 'resume the persisted session with this id, entering its own directory')
    .addHelpText('after', `
Examples:
  dsh                              run the TUI in this directory (the default profile)
  dsh --resume <id>                resume a persisted session in its own directory
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service, plus the
 * launcher-owned boot slots composed from it. The command's action publishes
 * the resumed identity and the process-local resources; `--help` and usage
 * errors provide nothing, mirroring the web app's flag behavior.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if (options.resume === '') program.error('error: --resume needs a session id')
    const resumeSessionId = options.resume
    const identity: LauncherAgentIdentity = resumeSessionId === undefined
      ? { id: SessionId(`main-session-${randomUUID()}`), resume: false }
      : { id: SessionId(resumeSessionId), resume: true }
    // The goodbye line names the session to resume; bare `dsh` boots the tui
    // profile, so the printed command re-enters the same surface unchanged.
    const goodbye = `To resume this session: dsh --resume ${identity.id}`
    const queryPath = join(tmpdir(), SESSION_QUERY_DB)
    ctx.provide(TUI_STARTUP_SERVICE, {
      sessionId: identity.id,
      ...resumeSessionId === undefined ? {} : { resumeSessionId },
      sessionQueryPath: queryPath,
    } satisfies TuiStartupValues)
    // Launcher-owned identity for the pre-created `main` agent. The agent-loop
    // row injects this service, so the provide lands before its constructor
    // reads the configuredAgentIdentities slot.
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: identity })
    ctx.provide(TUI_GOODBYE_MESSAGE_KEY, goodbye)
    ctx.provide(SESSION_QUERY_SQLITE_PATH_KEY, queryPath)
    // The index is disposable and process-local: one writer owns it, so the
    // whole file including WAL/SHM goes away with this process.
    ctx.effect(() => async () => {
      await Promise.all([
        rm(queryPath, { force: true }),
        rm(`${queryPath}-wal`, { force: true }),
        rm(`${queryPath}-shm`, { force: true }),
      ])
    }, `${SESSION_QUERY_SQLITE_PATH_KEY}.cleanup`)
    const entry = process.argv[1]
    const execve = process.execve?.bind(process)
    if (entry !== undefined && execve !== undefined) {
      const resumeHost: TuiResumeHost = {
        async handoff(sessionId, cwd): Promise<never> {
          const nextArgv = [process.execPath, ...process.execArgv, entry, '--resume', sessionId]
          // Enter the target workspace BEFORE teardown commits: an unreachable
          // directory must reject while the caller can still restore the
          // terminal, and a chdir after disposal would have no owner to report to.
          try {
            process.chdir(cwd)
          } catch (error) {
            throw new Error(`dsh: cannot resume in "${cwd}": ${String(error)}`)
          }
          try {
            await ctx.root.fiber.dispose()
            execve(process.execPath, nextArgv, process.env)
            throw new Error('process replacement returned unexpectedly')
          } catch (error) {
            process.stderr.write(`dsh: resume handoff failed after terminal release: ${String(error)}\n`)
            process.exit(1)
          }
        },
      }
      ctx.provide(TUI_RESUME_HOST_KEY, resumeHost)
    }
  })
  parseCmdline(ctx, program)
}
