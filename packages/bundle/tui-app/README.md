# @deepseek-ai/dsh-tui-app

English | [中文](README.zh.md)

The dsh terminal surface as a profile bundle: [`cordis.patch.yml`](cordis.patch.yml) applies the TUI patch layer over the `dsh-base` rows (mirroring how [`dsh-web-app`](../web-app/README.md) layers the Web surface), then inserts the terminal-only rows. A patch replaces the targeted row's whole `config`, so each row below restates every key it owns. The package has no runtime API beyond the patch manifest (`dsh.bundle.patch`) and the `startup`/`invariant` modules; the profile composer resolves the patch through the manifest field.

Rows that specialize base values: `system-prompt` sets the shipped coding-agent persona ("You are a coding agent powered by the {{model}} model..."), `agent-loop` binds one pre-created `main` agent to `deepseek-official`/`deepseek-v4-pro` at the invoking `cwd`, `llm-deepseek` sets full thinking at max effort, and `session-query-sqlite` points the `/resume` search index at a process-local disposable SQLite file. Inserted rows add the terminal-only surface: `tui-startup` (`@deepseek-ai/dsh-tui-app/startup`) parses the `--resume` flag family and provides the launcher-owned boot slots; `session-reference` with the `storage`/`storage-json`/`storage-domain`/`session-projection-cache` group mounts the derived session index and durable checkpoint cache over the shared Harness home storage root; `tmux-context` mounts terminal-multiplexer context; `tui-prompt` (`@deepseek-ai/dsh-tui/prompt`) backs the keyboard `ask_user_question` dialogs; `tui` (`@deepseek-ai/dsh-tui`) renders the surface with `showReasoning: true` and `maxToolOutputLines: 6`; and `tool-ask-user` provides the ask-user queue those dialogs read.

`tui-startup` owns the boot glue: it mints the session identity (fresh `main-session-<uuid>`, or the resumed id from `--resume <id>`), provides `configuredAgentIdentities`, the goodbye line, the disposable query-index path, and — where `process.execve` exists — the `tuiResumeHost` handoff that chdirs into the target workspace, disposes the app fiber, and replaces the process in place. The SQLite query index (`session-query-<pid>-<uuid>.db` under the OS temp dir) is process-local: one writer owns it, and the cleanup effect removes the file with its WAL/SHM at teardown.

## Model Experience

### Request route

#### What the model sees

The bundle mounts child plugins and patches base rows; the model-facing text is owned by the composed rows, not by this package. `system-prompt` supplies the persona the model sees, `agent-loop` fixes the model route and session identity, and `llm-deepseek` sets the thinking/reasoning-effort defaults; `tui-startup` provides configuration values (`tuiStartup.sessionId`, `tuiStartup.sessionQueryPath`) that rows read, and contributes no prompt content of its own. The prompt base assembled by `dsh-base` plus the `system-prompt` persona has the agent bound by `agent-loop` to `deepseek-official`/`deepseek-v4-pro`, and the `tui` row (`@deepseek-ai/dsh-tui`) renders that agent's transcript; nothing in this bundle adds a second voice to the conversation.

#### Token effect

The patch assembles no prompt text of its own, so it adds no per-request tokens beyond the composed base prompt and session history. Host-side machinery — the `session-projection-cache` checkpoint writes and the `session-query-sqlite` index behind `/resume` — stays out of the model context.

#### KV Cache effect

None directly; the bundle selects rows and provides configuration through `tui-startup`, while the adapter (`llm-deepseek`) and the `tui` renderer own any request-shape effects. Each mounted row's package documents its own impact.

## Known Limitations and Deferred Work

- **A patch replaces whole row configs** — `cordis.patch.yml` restates every key each row owns, and profile or `--patch` overlays targeting these ids must do the same; there is no deep-merge layer.
- **The `/resume` query index is process-local and disposable** — `tui-startup` creates `session-query-<pid>-<uuid>.db` under the OS temp dir and deletes it with its WAL/SHM at teardown, so every process rebuilds the index from the persistent session log root instead of reusing a durable index file.
- **In-place resume handoff requires `process.execve`** — `tui-startup` provides `tuiResumeHost` only when the entry script and `process.execve` exist; hosts without execve must restore the terminal and re-invoke separately.
