# Agent Note: Context-bloat handoff observer and skill

Status: implemented

## Problem

A long worked session pays the full prefix on every turn: once the conversation is large (a 1M-token window at ~600k used, or a raw transcript near 10 MB), each turn re-sends essentially the whole history and the marginal answer no longer earns its prefix. DeepSeek Harness already compacts under pressure (`compaction-basic`), but compaction is a *summarization* response: it condenses the record and can lose verbatim detail, and it re-prices through the token meter rather than preserving the exact project state and conversation. A user who must continue a large piece of work (a coding agent mid-feature, a long migration) often needs the opposite: the full repository and the full conversation preserved byte-for-byte, and the work continued in a fresh session.

Nothing in the harness detected this boundary or prompted a handoff. The previous workflow (back up the project as a bundle and tarball, export the conversation JSONL, write a `HANDOFF-<topic>.md` note, tell the user to open a fresh session) was manual and ad hoc — each time it was re-derived from scratch, and nothing told the user *when* to do it.

## Decision

Add two complementary surfaces, both named `dsh-context-handoff`:

### A skill: `dsh-context-handoff` (`.agents/skills/`)

A repository skill (SKILL.md + `agents/openai.yaml`) documenting the **manual fallback** flow, used when the plugin is not mounted, a backup step failed (`context/handoff.error`), or a deployment needs a hand-run backup:

- **Detect bloat** from durable facts: `ctx.tokenMeter.measure(session).totalTokens` at or above `0.6 × contextWindow` (the 600k/1M line), or a raw exported JSONL above ~10 MB for sessions without a meter.
- **Back up the project**: `git bundle create --all` (full-history, clone-able) plus a source tarball excluding `.git`/`node_modules`/`lib`/known junk, verified against the previous backup.
- **Export the conversation**: `$DSH_SESSION_JSONL` (the live session's zstd JSONL) copied and decompressed into the backups directory.
- **Write the handoff note**: the `HANDOFF-<topic>.md` sections (目标 / 已交付 / 关键文件 / 仓库状态 / 备份 / 下一步 / 环境备注), each referenced commit and path verified.
- **Prompt the fresh session**: a 2–3 line message naming the note and the JSONL to read.

The skill format follows the repository's existing `.agents/skills/*/SKILL.md` conventions and passes `verify-skill-invocation-metadata`.

### A plugin: `@deepseek-ai/dsh-context-handoff` (`packages/guard/context-handoff/`)

A timeline-independent observer on its own clock (`ctx.effect` + `setInterval`, the same effect-disposer pattern as `dsh-observer`), consuming the token meter and **performing the handoff automatically**:

- Each tick, measure every live session (`ctx.tokenMeter.measure(session)`).
- Resolve the routed model's `contextWindow` once per `provider/model` key via `ctx.llm.resolveModelInfo` (the same call `compaction-basic` uses) and cache the resulting `thresholdTokens = floor(contextWindow * thresholdRatio)`.
- When `totalTokens >= thresholdTokens`, run an injectable `backupRunner` (default: child-process `git bundle --all` + tarball + `$DSH_SESSION_JSONL` copy) that writes the bundle, tarball, JSONL, and the rendered `HANDOFF-<topic>.md` note.
- Append a durable `context/handoff` session event carrying every artifact path (`backupDir`, `bundlePath`, `tarballPath`, `jsonlPath`, `notePath`) and the cycle — the record satisfies model-visible ⟺ logged — then `agent.inject()` a reminder stating the completed backup and the fresh-session instruction. Each session fires at most once (`fired` per-session state, dropped on disposal).
- Backup failures are captured into the notice's `error` field; the notice is never suppressed and never fabricated (measure-then-notice).

The package owns a `./invariant` companion verifying the measure-then-notice ordering: every `context/handoff` event's `totalTokens` must be at least its own `thresholdTokens`, so a notice can never be fabricated without a pressure measurement that crossed the boundary.

`Config`: `tickMs` (default 10_000), `thresholdRatio` (default 0.6), `cycle` (default 0), `backupDir` (default `~/backups`), `projectDir` (default `process.cwd()`), `topic` (default derived from the session id), `excludePatterns` (default `.git`, `node_modules`, `lib`), and the injectable `backupRunner` (default child-process implementation).

## Alternatives considered

**Extend `compaction-basic` with a "handoff instead of compact" mode.** Compaction owns pressure-triggered summarization and its own retry/overflow machinery; adding a verbatim-preservation mode would overload one capability with two opposite retention policies. A separate guard keeps compaction's contract intact and lets a deployment mount either (or both): compact for summarized continuation, handoff for verbatim preservation.

**Keep backups in the agent tool surface (skill-only).** The prior slice ran the backup through agent tools driven by a skill, which is reliable but manual and re-derived each time. The user's requirement is a plugin that does the work: an automatic observer that shells out to host CLIs (`git`, `tar`, copy) inside the plugin process, with the runner injectable for tests and constrained environments. The skill stays as the manual fallback and the documentation of the exact commands.

**Detect bloat from raw transcript size only.** The token meter already prices the *assembled request* (the thing that actually costs), and its `totalTokens` is the exact pressure the model would pay. Transcript byte size is a fallback for sessions without a meter, encoded in the skill, not a second engine in the plugin.

## Consequences

The harness now has a first-class signal for "this session is past comfortable work" and the plugin performs the verbatim continuation automatically. The cost:

- **Detection is heuristic** — the meter's fixed estimator or last provider-usage anchor, not a live provider accounting; a provider-confirmed overflow stays compaction's `context-overflow` trigger. Practically, the 600k/1M line is well before overflow, so the handoff runs comfortably early.
- **Backup depends on host CLIs and process rights** — the default runner shells out to `git`/`tar` and copies files under the plugin's process identity; sandboxed or CLI-less deployments inject a `backupRunner`.
- **JSONL export needs `DSH_SESSION_JSONL`** — the host exposes the live session record; without it, the conversation export is skipped (bundle and tarball still land).
- **One handoff per session** — after the first `context/handoff`, pressure can keep climbing past the threshold and the observer stays quiet (the notice remains the record). A deployment wanting repeated reminders can raise the cap; deferred.
- **In-memory state only** — `fired` is keyed by the live `Session`; a resumed session re-arms the threshold.
- **The skill is the fallback, not the driver** — with the plugin mounted, the agent does not need to run the skill; the skill documents the exact commands for the manual path and the recovery path after a failed backup (`context/handoff.error`).

## The sustained loop

The two observers compose into a cycle instead of one-shot fire: `dsh-observer` guards each session's hygiene (stalls, loops, budgets) and `dsh-context-handoff` guards its lifespan (bloat). On a handoff:

- The handoff notice carries `cycle` (a `Config` field, default 0). The fresh session mounts `dsh-context-handoff` with `cycle` bumped one past the last notice, so the durable record sequences generations.
- `dsh-observer` consumes the durable `context/handoff` event and **cedes**: `handoffRequested` per-session state stops all further observer intervention, because the handoff flow now owns termination. The hygiene guard cannot cancel or steer a session the owner chose to hand off verbatim.
- The reminder text (and the `dsh-context-handoff` skill's "Sustain the monitoring loop" section) tells the agent and the fresh session to restore both plugins with the bumped cycle, keeping the loop alive across as many generations as the work needs.

## The barber paradox, and the twin solution

The harness's own observers face the classic self-reference problem:

- **Who watches the watcher?** An observer that can judge any session can judge *its own host's* session — the same agent driving the work being observed. An observer that reports its own backup complete can be lying about itself (the artifact claim is the judge being the judged).
- **The twin fix (observer):** `Config.twinId` narrows an observer to judge exactly one agent — its twin. Two observers A and B with `twinId` pointing at each other form a closed mutual loop: A judges B's session, B judges A's, and neither can judge itself. The judge is always external to the judged. Without `twinId`, the observer is the un-twin, self-referencing configuration (judges everything it sees).
- **The twin fix (backup):** `defaultBackupRunner` refuses a `backupDir` inside `projectDir` (a project archiving its own backup output would recurse into itself), and stats every artifact it writes, returning `verified` paths the notice records — file facts, not the runner's claim. The twin observer then judges that session independently of the claim.

## Testing

`packages/guard/context-handoff/tests/context-handoff.spec.ts` (7 tests, fake timers + a real AgentLoop and real TokenMeter, an injected in-memory `backupRunner`): crossing the threshold runs the backup runner before the notice, appends a durable notice carrying the artifact paths, and injects the fresh-session reminder; the cycle is recorded and the reminder names the next cycle; a backup failure surfaces in `error` without suppressing the notice; a session fires at most once; a session below the threshold stays silent (no backup, no notice); the default runner refuses a self-referencing `backupDir`; a runner that really wrote files reports `verified`. The real `defaultBackupRunner` is exercised by a live smoke run (git bundle of a real worktree + tarball + JSONL copy + note write). `observer.spec.ts` gains a cede test and a twin test (with `twinId`, the observer judges only the twin and leaves the other session untouched). `invariant.spec.ts` (3 tests) covers the measure-then-notice invariant (accepts at/above threshold, rejects below, ignores unrelated events). Guards: `tsc -b tsconfig.host.json`, `oxlint packages/guard/observer packages/guard/context-handoff`, `build:lib:host` (the package builds to `lib/`), `verify-package-invariants` (the companion registers), and `verify-skill-invocation-metadata` (the skill pair aligns) all pass.