# @deepseek-ai/dsh-observer-loop

English | [中文](README.zh.md)

The observer resilience profile bundle for DeepSeek Harness: the [hygiene guard](../../guard/observer/README.md) and the [verbatim handoff with automatic backup](../../guard/context-handoff/README.md) as one patch layer over `dsh-base`. Any workspace that mounts this profile gets the full twin/ring/DNA resilience loop without per-project configuration.

## Run

Create and boot a profile with this bundle (the `dsh plugin` path initializes the profile and reconciles bundle-declaring packages into the bundle layer list):

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-observer-loop
dsh --profile web
```

Every session in any workspace launched under this profile carries the loop: the observer guards hygiene (turn budget, silence, turn cap, repeated tool calls), the handoff detects bloat at 0.6 of the routed model's context window and automatically backs up the project + conversation + handoff note into `$DSH_HOME/backups`, retains 3 generations, and scrubs daily (`git bundle verify`, dropping corrupt generations). `projectDir` defaults to the launching workspace, so one deployment value serves every project.

## Composition

The bundle patch inserts two rows:

| Row | Plugin | Deployment defaults |
|---|---|---|
| `observer` | `@deepseek-ai/dsh-observer` | `tickMs: 1000`, `maxTurnSeconds: 300`, `maxSilenceSeconds: 120`, `maxTurns: 50`, `maxRepeatedToolCalls: 3` |
| `context-handoff` | `@deepseek-ai/dsh-context-handoff` | `thresholdRatio: 0.6`, `backupDir: dshHomePath('backups')`, `keepCycles: 3`, `scrubMs: 86400000`, excludes `.git`/`node_modules`/`lib`/`dist`/`build` |

Later bundle layers and the user's `cordis.patch.yml` override these rows by id; a patch replaces a row's whole `config`. Twin/ring pairing (`twinId` / `ringIds`), per-project `backupDir`, and custom budgets are exactly such overlays.

## Model Experience

Indirectly, through the inserted rows: each row's package owns its injected notices and reminders. The bundle itself contributes no model-visible text.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **Un-twin by default** — without a `twinId`/`ringIds` overlay the observer judges every session it sees; deployment overlay provides the barber-paradox-safe pairing.
- **Backup needs host CLIs** — the default executor shells out to `git`/`tar`; sandboxed or CLI-less workspaces inject a `backupRunner`.