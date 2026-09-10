# Agent Note: LLM-judging tick roles and observer silence classification

Status: implemented

English | [中文](2026-09-10-tick-role-llm-judge.zh.md)

## Problem

The fleet tick observer ([2026-08-29-timeline-independent-fleet-observer](2026-08-29-timeline-independent-fleet-observer.md)) evaluates only deterministic budget counters: turn duration, silence, turn count, and repeated tool calls. Those rules notice a worker that *stalls* or *loops* on identical actions, but a worker can make steady, varied progress and still drift from the task — editing the wrong file, solving a different problem, or re-running a losing approach with new parameters. The deferred LLM-judging tick role (a model call per interval judging intent) was the natural extension, but an unbounded per-interval model spend needs an explicit opt-in and a separate cadence.

The silence budget also had a classification gap shared with the guard: the observer's own durable bookkeeping (`fleet/review`, `fleet/run`, `fleet/end` in the fleet; `observer/notice` and the observer's plugin-sourced `agent/inbox/spliced` deliveries in the guard) fell to the `default → progress = true` branch, so the observer's own interventions refreshed the silence clock. A stalled worker echoed by repeated reminders could look alive forever — the exact stall the silence rule exists to catch.

## Decision

Two changes ship together, fleet and guard:

### 1. LLM-judging tick roles (`judge: true`)

A `FleetRoleConfig` gains `judge?: boolean`; a tick role with `judge: true` (and only a tick role — `resolveConfig` rejects `judge: true` on a `turn-stopping` role) runs a direct LLM pass over the live activity window on its own interval. `Config` gains `judgeIntervalMs` (default `tickMs`) and `judgeTranscriptChars` (default `maxTranscriptChars`).

Per tick, after the deterministic rules find nothing, each `judge: true` tick role whose interval is due passes the task, the recent-activity window (`judgeWindow`: newest-first `step/start|step/end|tool/call|assistant/message` records, capped), and the role's instructions to the role's route. The parse follows the reviewer contract — unparseable output is a fix request with the raw text. The verdict is recorded as a durable `fleet/review` with `kind: 'observer'` (a `pass` is log-only; a `fix` steers its feedback and closes the run `observer-triggered`). The route is resolved once at plugin apply, and a `judging` flag drops an in-flight interval so a slow model call never queues — a skipped interval only delays the next pass.

### 2. Observer silence classification (fleet and guard)

Both `isProgressEvent` classifiers now treat the observer's own bookkeeping as non-progress:

- Fleet: `fleet/run`, `fleet/review`, `fleet/end`.
- Guard: `observer/notice`.
- Both: `agent/inbox/spliced` is progress only when a spliced-in message is user-sourced (a splice that only inserts plugin messages — the observer's own inject/steer — is the observer talking, not the worker working).

`todo/write`, `request/header`, `request/context`, `session/end-seed`, and plugin-sourced `user/message` remain non-progress as before.

## Alternatives considered

**Let the deterministic evaluator call the LLM itself when a rule is close.** Rejected: the deterministic rules are the cheap tripwire; folding a model call into them would spend on every near-miss and blur the two costs. The judge stays an explicit role flag with its own interval.

**Judge on every tick without a `judging` flag.** Rejected: a slow judge would queue intervals and pile model spend behind a stalled worker. The flag drops the in-flight overlap; the cost is bounded at one in-flight judge per role.

**Fix the silence classifier only in the fleet.** Rejected: the guard has the identical gap (its own `observer/notice` and plugin deliveries refreshed its silence clock). Both surfaces share the same fact-stream contract, so both are fixed together.

## Consequences

- A fleet can now notice a worker that *drifts* while still making steady progress — the deterministic rules never can — at an explicit per-interval model cost (`judgeIntervalMs`) that a deployment opts into with `judge: true`.
- The silence budget measures the worker's progress, not the observer's own noise: in both the fleet and the guard, repeated reminders no longer keep a stalled worker "alive".
- A `judge: true` tick role's route is resolved once at apply, so it cannot follow a mid-run default-route change — the same constraint the turn-stopping reviewer route has per call is tightened to per-role. A run that needs the judge on a different route must be re-composed.
- The judge window is the recent session log, not the workspace: file diffs and tool results are not included, the same transcript-only limitation as reviewers.

## Testing

- `packages/codewhale/fleet/tests/tick-observer.spec.ts` (7): the two judge tests drive a scripted judge route — a `pass` records a `kind: 'observer'` review and leaves the run active; a `fix` steers its feedback and closes the run `observer-triggered` — plus the existing budget-rule tests.
- `packages/codewhale/fleet/tests/fleet.spec.ts` (13): `resolveConfig` rejects `judge: true` on a non-tick role and non-positive judge budgets, and accepts a judging tick role with its own route and budgets.
- `packages/codewhale/fleet/tests/loader-composition.spec.ts` (6): a judging tick role mounts through the real Loader schema with its budgets.
- `packages/guard/observer/tests/observer.spec.ts` (10): a new test asserts the observer's own notices never refresh the silence clock — with a 1s turn budget and 3s silence budget, the silence rule still fires at ~3s despite the level-1 notice landing mid-window.
- Guards: `tsc -b tsconfig.host.json` on the touched packages, `oxlint`, and the package test suites all pass.
