# Agent Note: CodeWhale profile on DeepSeek Harness

Status: implemented

English | [中文](2026-08-14-codewhale-profile-on-dsh.zh.md)

## Problem

CodeWhale (formerly DeepSeek-TUI) ships three signature mechanisms — multi-model fleet review, a workspace constitution with write holds, and turn-level workspace snapshots with undo/restore — as one Rust binary. Porting them into DeepSeek Harness means reimplementing each mechanism on the harness's plugin seams rather than reproducing the binary: the session log is the durable ledger, the fs decision waterfalls are the write-hold enforcement point, and the command registry is the slash-command surface.

## Decision

**Three function plugins under `packages/codewhale/`, one profile bundle.** `dsh-codewhale-constitution` renders a workspace YAML file into the `codewhale:constitution` prompt section (order 60) and occupies the `fs/write-intent`/`fs/edit-intent` single-slot decision waterfalls with `prepend: true`, throwing `FS_PERMISSION_DENIED` for held targets and delegating through `next()` otherwise. Prepend is load-order-proof: the base bundle's observation policy mounts before this plugin, and the single-slot waterfalls run listeners in registration order. `dsh-codewhale-snapshot` hooks `session/event` `turn/end`, copies the workspace (minus configured excludes) into `$DSH_HOME/codewhale/snapshots/<sessionId>/<seq>/` when its content fingerprint changed, and registers `/undo` and `/restore`; restores are durable `snapshot/restore` events plus an injected model-visible notice. `dsh-codewhale-fleet` hooks `agent/turn-stopping`, runs one direct LLM pass per reviewer role on its own provider/model route (falling back to `ctx.agentDefaultModel`), and steers fix feedback back into the session; the session log itself is the fleet ledger (`fleet/run`, `fleet/review`, `fleet/end`), so status, resume, and replay fold from the log with no live mirror. The `dsh-codewhale` bundle inserts the three rows over `dsh-base`; a `codewhale` profile boots via `dsh plugin --profile codewhale add @deepseek-ai/dsh-web-app @deepseek-ai/dsh-codewhale`.

**Reviewer verdicts are a fixed JSON protocol.** `{"verdict": "pass" | "fix", "feedback": "..."}` is a protocol constant; unparseable reviewer output counts as a fix request carrying the raw text, so a review can never masquerade as a pass.

## Alternatives considered

**Enforce write holds at the tool layer.** Rejected: wrappers are not enforcement, and the repo rule requires denying through the operation that makes the decision — the fs waterfalls are that operation for the model-facing fs tools.

**Add a reject variant to `FsWriteIntent`.** Rejected: denial in the single-slot waterfall is expressed by throwing `FsError`, exactly as the observation policy denies unobserved edits; widening the intent union would change a core contract for one consumer.

**A file-based fleet ledger.** Rejected: the session log already is an append-only, replayable ledger, and logging the fleet events there satisfies the model-visible ⟺ logged invariant without a second persistence layer.

**Sandbox-level write holds.** Rejected for this milestone: path-level denial inside the sandbox policy would cover shell writes but requires changing the sandbox service and providers; the fs-waterfall enforcement covers the model-facing fs tools, and shell-write coverage is recorded as a known limitation.

## Consequences

A `codewhale` profile gives the harness the CodeWhale mechanisms as composable plugins: `/fleet run [task]` starts multi-model review rounds after each turn (max `maxRounds`), `/undo` and `/restore` roll the workspace back to exact snapshots, and a workspace `codewhale.constitution.yml` injects standing instructions and rejects writes to held paths regardless of approval posture. Every plugin registers through documented extension points; no agent-loop or core contract changed. Reviewer passes send the task plus the latest assistant response only, so transcript caps bound their cost; snapshot copies are whole-workspace, so large repositories pay per-turn copy cost — both recorded as known limitations for follow-up. The bundle ships no TUI; terminal users mount a community TUI plugin beside it.
