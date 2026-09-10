# Agent Note: Timeline-independent observer for codewhale-style fleets

Status: implemented

## Problem

The [`codewhale-profile-on-dsh` implemented note](../feature/2026-08-14-codewhale-profile-on-dsh.md) establishes `@deepseek-ai/dsh-codewhale-fleet` as a turn-stopping reviewer: each *turn* is reviewed as it stops (`agent/turn-stopping`), and fixes are steered back. That is a turn-coupled reviewer — it can only judge completed turns, cannot notice a stalled or looping *in-flight* turn, and has no independent clock. A long-running worker that stalls mid-turn, loops on the same tool, or exceeds a budget is invisible to `codewhale-fleet` until its turn ends (which a stall never does).

## Decision

Add a tick observer to the fleet: a role with `cadence: 'tick'` evaluates the LIVE worker facts on the fleet's own `setInterval`, independent of the turn boundary, and intervenes at three levels. This mirrors the single-agent [observer guard](../feature/2026-08-29-timeline-independent-agent-observer.md) but is fleet-owned: the tick role is a `FleetRoleConfig`, its record rides the existing `fleet/review` event with a `kind: 'observer'` discriminator, and a level-3 cancel closes the run `observer-triggered`.

### `FleetRoleConfig.cadence` and `Config` budgets

`FleetRoleConfig` gains `cadence: 'turn-stopping' | 'tick'` (default `turn-stopping`, the existing reviewer). `Config` gains the tick budgets — `tickMs` (default 1000), `maxTurnSeconds`, `maxSilenceSeconds`, `maxTurns`, `maxRepeatedToolCalls` — each a plain number where `0`/negative/`NaN` disables the rule. `resolveConfig` validates the cadence via `isFleetCadence` and accepts the new keys. The `fleet/review` event gains an optional `kind: 'observer'`; `fleet/end` gains the `observer-triggered` reason; the invariant companion validates both.

### Tick observer machinery

Per-session `ObserverSessionState` (a `WeakMap`, mirroring the guard) is derived from the durable log:

- `session/event` updates state: `turn/start` arms `activeTurn`/`activeTurnStartedAt` and increments `turnCount`; `turn/end` disarms; `tool/call` advances the repeat chain (deep-sorted canonical key); other progress events refresh `lastProgressAt` (plugin-sourced `user/message` and bookkeeping events excluded).
- A fleet-owned `setInterval` (when any tick role exists) evaluates the deterministic rules — turn budget, silence budget, turn cap, repeated tool calls — against the state and the live agent (resolved lazily each tick via `ctx.get('agents')`, so a loop composed later is still observed).
- A tripped rule appends `fleet/review` with `kind: 'observer'` and `verdict: 'fix'` (any tripped rule is a fix; `pass` is reserved for a no-trip evaluation, which this path never produces), then acts at the verdict's level: level 1 `agent.inject()` (remind), level 2 `agent.steer()` (redirect), level 3 `agent.cancel({kind:'hook', reason:'observer <rule>: …'})` plus `fleet/end reason: 'observer-triggered'` (stop). Level 2/3 intervene at most once per session (`cancelledOnce`).

`turn-stopping` roles are skipped in the tick path and tick roles are skipped in the review-turn loop, so the two cadences compose in one config.

### Security and containment

The tick observer never mutates worker state directly — only through `inject`/`steer`/`cancel`, the same inbox boundaries a user uses. Secrets stay on the role's own LLM route; the observer evaluates deterministic facts from the log, never from worker claims. Cancellation uses the hook cause prefixed `observer <rule>:`, and the tick records its own durable `kind: observer` review before cancelling (the guard's notice-before-hook invariant holds for guard-mounted workers).

## Alternatives considered

**Extend the guard with fleet awareness instead of adding a role.** The guard is already per-session; making it fleet-aware means teaching it to aggregate multiple sessions and naming a run. That conflates a single-agent hygiene guard with a multi-agent orchestrator. Keeping the [guard per-worker](../feature/2026-08-29-timeline-independent-agent-observer.md) unchanged and adding a fleet-owned tick role keeps the two surfaces composable: the guard is the per-worker teeth, the tick role is the per-run eyes.

## Consequences

The fleet now notices stalled, looping, or over-budget workers *while* they run, not only at a completed turn boundary — the gap the turn-stopping reviewer had. The cost:

- **Tick cadence is cost-free until a judge role is composed** — the budgets are counters against the durable log, so no LLM call happens per interval. A tick role with `judge: true` opts into one LLM pass per `judgeIntervalMs` over the live activity window ([2026-09-10-tick-role-llm-judge](2026-09-10-tick-role-llm-judge.md)); the budget-only evaluator never spends one.
- **`agent.inject` on a worker with no active turn parks** until the next wake; the tick only fires within an active run (`activeFleetRun` present) and level-2/3 actions check `cancelledOnce`.
- **Run-level cancellation is per-session**: the tick cancels the one worker whose session is the run, then records `fleet/end observer-triggered`. Multi-worker sibling policy on one cancel is out of scope for this slice — the TS fleet is per-session; the Rust `codewhale_new` fleet owns multi-node orchestration.
- **A tripped rule always records `verdict: 'fix'`**, so status rendering cannot mistake an observer intervention for a clean pass; the rule id and delivered text ride `reason`/`feedback`.

## Testing

`packages/codewhale/fleet/tests/tick-observer.spec.ts` (5 tests, fake timers + a real agent loop) covers: level-1 turn-budget inject, level-2 repeated-tool steer, level-3 turn-cap cancel producing `fleet/end observer-triggered`, log-only reconstruction (the `kind: 'observer'` review follows the `fleet/run` in log order), and coexistence with a turn-stopping reviewer. Existing `fleet.spec.ts` and `loader-composition.spec.ts` preserve the folds/parse/config and the turn-stopping loader path — 20 fleet tests pass. Guards: `tsc -b tsconfig.host.json`, `oxlint packages/codewhale/fleet`, `build:lib:host`, `verify-package-invariants`, and the README limitations gate all pass. The guard tier stays covered by `packages/guard/observer/tests/observer.spec.ts` (9) and `invariant.spec.ts` (3).
