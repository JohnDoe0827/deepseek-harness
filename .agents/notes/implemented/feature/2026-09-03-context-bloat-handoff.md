# Agent Note: Context-bloat handoff observer and skill

Status: implemented

## Problem

A long worked session pays the full prefix on every turn: once the conversation is large (a 1M-token window at ~600k used, or a raw transcript near 10 MB), each turn re-sends essentially the whole history and the marginal answer no longer earns its prefix. DeepSeek Harness already compacts under pressure (`compaction-basic`), but compaction is a *summarization* response: it condenses the record and can lose verbatim detail, and it re-prices through the token meter rather than preserving the exact project state and conversation. A user who must continue a large piece of work (a coding agent mid-feature, a long migration) often needs the opposite: the full repository and the full conversation preserved byte-for-byte, and the work continued in a fresh session.

Nothing in the harness detected this boundary or prompted a handoff. The previous workflow (back up the project as a bundle and tarball, export the conversation JSONL, write a `HANDOFF-<topic>.md` note, tell the user to open a fresh session) was manual and ad hoc — each time it was re-derived from scratch, and nothing told the user *when* to do it.

## Decision

Add two complementary surfaces, both named `dsh-context-handoff`:

### A skill: `dsh-context-handoff` (`.agents/skills/`)

A repository skill (SKILL.md + `agents/openai.yaml`) that defines the complete handoff flow the agent follows when a session is bloated:

- **Detect bloat** from durable facts: `ctx.tokenMeter.measure(session).totalTokens` at or above `0.6 × contextWindow` (the 600k/1M line), or a raw exported JSONL above ~10 MB for sessions without a meter.
- **Back up the project**: `git bundle create --all` (full-history, clone-able) plus a source tarball excluding `.git`/`node_modules`/`lib`/known junk, verified against the previous backup.
- **Export the conversation**: `$DSH_SESSION_JSONL` (the live session's zstd JSONL) copied and decompressed into the backups directory.
- **Write the handoff note**: the `HANDOFF-<topic>.md` sections (目标 / 已交付 / 关键文件 / 仓库状态 / 备份 / 下一步 / 环境备注), each referenced commit and path verified.
- **Prompt the fresh session**: a 2–3 line message naming the note and the JSONL to read.

The skill format follows the repository's existing `.agents/skills/*/SKILL.md` conventions and passes `verify-skill-invocation-metadata`.

### A plugin: `@deepseek-ai/dsh-context-handoff` (`packages/guard/context-handoff/`)

A timeline-independent observer on its own clock (`ctx.effect` + `setInterval`, the same effect-disposer pattern as `dsh-observer`), consuming the token meter:

- Each tick, measure every live session (`ctx.tokenMeter.measure(session)`).
- Resolve the routed model's `contextWindow` once per `provider/model` key via `ctx.llm.resolveModelInfo` (the same call `compaction-basic` uses) and cache the resulting `thresholdTokens = floor(contextWindow * thresholdRatio)`.
- When `totalTokens >= thresholdTokens`, append a durable `context/handoff` session event (`{ target, totalTokens, contextWindow, thresholdTokens, ratio, reason }`) — the record satisfies model-visible ⟺ logged — and `agent.inject()` a reminder naming the skill. Each session fires at most once (`fired` per-session state, dropped on disposal).
- The plugin never compacts and never touches the filesystem: it detects and reminds; the *agent* performs the backup and handoff by running the skill. That keeps the guard inside the "observe and remind" surface and the filesystem work in agent tools, per DSH's plugin boundary.

The package owns a `./invariant` companion verifying the measure-then-notice ordering: every `context/handoff` event's `totalTokens` must be at least its own `thresholdTokens`, so a notice can never be fabricated without a pressure measurement that crossed the boundary.

`Config`: `tickMs` (default 10_000) and `thresholdRatio` (default 0.6). Both are plain numbers; the boundary derives from the adapted model's disclosed `contextWindow`, and targets without disclosed capacity are skipped.

## Alternatives considered

**Extend `compaction-basic` with a "handoff instead of compact" mode.** Compaction owns pressure-triggered summarization and its own retry/overflow machinery; adding a verbatim-preservation mode would overload one capability with two opposite retention policies. A separate guard keeps compaction's contract intact and lets a deployment mount either (or both): compact for summarized continuation, handoff for verbatim preservation.

**Have the plugin perform the backup itself (write files).** DSH keeps filesystem mutation in agent tools, not guard plugins; a guard writing bundles and tarballs would duplicate tool capabilities, need file permissions, and break the "observe and remind" boundary. The plugin detects and reminds; the skill tells the agent exactly which tools to run.

**Detect bloat from raw transcript size only.** The token meter already prices the *assembled request* (the thing that actually costs), and its `totalTokens` is the exact pressure the model would pay. Transcript byte size is a fallback for sessions without a meter, encoded in the skill, not a second engine in the plugin.

## Consequences

The harness now has a first-class signal for "this session is past comfortable work" and a repeatable, versioned procedure for continuing verbatim. The cost:

- **Detection is heuristic** — the meter's fixed estimator or last provider-usage anchor, not a live provider accounting; a provider-confirmed overflow stays compaction's `context-overflow` trigger. Practically, the 600k/1M line is well before overflow, so the handoff runs comfortably early.
- **One reminder per session** — after the first `context/handoff`, pressure can keep climbing past the threshold and the observer stays quiet (the notice remains the record). A deployment wanting repeated reminders can raise the cap; deferred.
- **Backup is agent work** — the plugin does not guarantee the backup happened; it guarantees the durable notice and the reminder. The skill's verify steps are the agent-side guarantee.
- **In-memory state only** — `fired` is keyed by the live `Session`; a resumed session re-arms the threshold.
- The plugin and skill share the name by design: the plugin's reminder tells the agent to load the skill, and the skill is the only surface that knows the exact backup/export steps.

## Testing

`packages/guard/context-handoff/tests/context-handoff.spec.ts` (3 tests, fake timers + a real AgentLoop and real TokenMeter): crossing the threshold appends a durable notice with the right fields and injects a reminder naming the skill; a session fires at most once across repeated ticks; a session below the threshold stays silent. `invariant.spec.ts` (3 tests) covers the measure-then-notice invariant (accepts at/above threshold, rejects below, ignores unrelated events). Guards: `tsc -b tsconfig.host.json`, `oxlint packages/guard/context-handoff`, `build:lib:host` (the package builds to `lib/`), `verify-package-invariants` (the companion registers), and `verify-skill-invocation-metadata` (the skill pair aligns) all pass.