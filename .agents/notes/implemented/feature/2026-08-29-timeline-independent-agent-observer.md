# Agent Note: Timeline-independent agent observer guard

Status: implemented

## Problem

An agent can stall mid-turn, loop on identical tool calls, or exceed a wall-time budget without ever reaching a turn-stopping boundary that the existing guards observe: `repeat-tool-reminder` only nudges on repetition, and `timeout-policy` only arms per-call deadlines. Nothing watches the *duration and liveness* of an in-flight turn or session, and nothing can escalate from a reminder (inject) to a redirect (steer) to a stop (cancel) based on observed facts alone.

## Decision

Add `@deepseek-ai/dsh-observer` under `packages/guard/observer/`: a timeline-independent observer that runs on its own `setInterval`, consuming the durable `session/event` broadcast, live `agent/*` events, and `tool/call` records, evaluating user-configured rules, and intervening at three escalating levels through the same inbox boundaries a user would use.

### Config rules

`Config` fields (each a plain number; `0`/negative/`NaN` disables the rule): `tickMs` (default 1000), `maxTurnSeconds` (default 300), `maxSilenceSeconds` (default 120), `maxTurns` (default 50), `maxRepeatedToolCalls` (default 3), `enableStandingReminder`.

### Per-session state and fact stream

`ObserverState` is held in a `WeakMap<Session, ObserverState>` with a parallel `Set<Session>` for iteration; disposed sessions drop their state automatically. The fact stream:

- `session/event`: `turn/start` arms `activeTurn`/`activeTurnStartedAt` (1-based increments `turnCount`); `turn/end` disarms; `tool/call` advances the repeat chain (deep key-sorted canonical `(name, args)` key); other progress events (excluding `todo/write`, `request/header`, `request/context`, `session/end-seed`, and plugin-sourced `user/message`) refresh `lastProgressAt`.
- `agent/created` seeds state; `agent/disposed` drops it; `agent/status idle` refreshes `lastProgressAt`.

### Evaluation and intervention

The tick evaluates the rules against the state, strongest-first (a higher level wins), and once per rule per turn (`fired` set cleared on `turn/start`):

| Level | Rule(s) | Action |
|---|---|---|
| 1 (remind) | `turn-budget` | `agent.inject(message)` — queued for the next step |
| 2 (redirect) | `silence-budget`, `repeated-tool` | `agent.steer(message)` — nearest step, once per session |
| 3 (stop) | `turn-cap` | `agent.cancel({kind:'hook', reason:'observer <rule>: …'})` |

Every intervention appends a durable `observer/notice` session event (`{ rule, level, reason, text }`), so the log reconstructs what the observer did and why. A level-2/3 steering cancel is delivered at most once per session (`cancelledOnce`). The agent registry is read lazily each tick via `ctx.get('agents')`, so a loop composed after the observer mounts is still observed.

## Alternatives considered

**Extend `repeat-tool-reminder` or `timeout-policy` instead of a new package.** Those guards serve one narrow pattern each (advisory repetition nudges; per-call deadlines). The observer's contract — independent clock, multi-rule budgets, escalating intervention, durable notice record — is a different surface; folding it into either would overload a focused guard with an orchestrator-shaped responsibility. A separate `guard/` package keeps pattern guards single-purpose.

## Consequences

The observer gives any agent (or, per the fleet note, any worker) an independent watchdog that notices in-flight stalls, loops, and budget overruns and can escalate from reminder to stop. The cost:

- **In-memory only**: observation state is not persisted; a resumed session starts fresh and re-accumulates budget counters.
- **Exact-match repeat detection**: canonicalization is a deep key-sort, so near-identical tool calls (whitespace-only differences inside a string) evade the repeat chain. Fuzzy matching is rejected pending evidence of need.
- **One steering cap per session**: after the first level-2+ intervention, later rule firings only append notices. Raise the cap if a deployment wants repeated redirection (deferred).
- **No LLM-driven evaluation**: rules are deterministic counters against observed facts. An LLM judge (evaluating whether *intent* is served) is a natural extension that plugs into the same fact stream and emits the same `observer/notice` shape; deferred.

## Testing

`packages/guard/observer/tests/observer.spec.ts` (9 tests, fake timers + scripted adapters) covers each rule firing at its level, the disabled-rule semantics (`0`/negative/`NaN` never fire), and no-fire behavior when all rules are disabled. `invariant.spec.ts` (3 tests) covers the durable ordering invariant: an observer hook-caused `turn/end` must have a preceding level-3 `observer/notice` in the same session. Guards: `tsc -b tsconfig.host.json`, `oxlint packages/guard/observer`, `build:lib:host`, `verify-package-invariants`, and the README limitations gate all pass.