# @deepseek-ai/dsh-codewhale-fleet

English | [中文](README.zh.md)

CodeWhale-style fleets for DeepSeek Harness: after each turn of an active fleet run, reviewer roles — each with its own provider, model, and reasoning tier — review the task and the agent's latest response through direct LLM calls. A reviewer requesting fixes steers its feedback back into the session so the next step addresses it; when every reviewer passes, the run closes clean. A run closes `fixes-exhausted` after `Config.maxRounds` review rounds.

A role with `cadence: 'tick'` is an **observer**, not a reviewer: it runs on the fleet's own clock and evaluates live worker facts — turn duration, silence (no-progress), turn count, and repeated tool calls — against the numeric budgets in `Config`, intervening at three levels (inject → steer → cancel) and recording each intervention as a durable `fleet/review` event with `kind: 'observer'`. A level-3 turn-cap cancel closes the run `observer-triggered`.

The session log is the run ledger: `fleet/run`, `fleet/review`, and `fleet/end` events are durable, so status, resume, fork, and replay all fold from the log with no live mirror.

## Composition

The plugin hooks `agent/turn-stopping` (the stop boundary the loop awaits before closing a turn), runs tick-observer roles on their own `setInterval`, and registers the `/fleet` command through `ctx.commands`:

- `/fleet run [task]` — start a run; the optional task is steered as a user message.
- `/fleet resume` — re-run the reviews for the active run manually.
- `/fleet` / `/fleet status` — render the ledger.

Each role may name its own `provider`/`model`/`reasoningEffort`; a role naming neither falls back to the session's default route (`ctx.agentDefaultModel`), so a fleet can span vendors in one run or stay on the deployment default. Reviewer output is parsed as a JSON object `{"verdict": "pass" | "fix", "feedback": "..."}`; unparseable output counts as a fix request carrying the raw text, so a review can never masquerade as a pass. Tick roles never spend a model call: their budgets are deterministic counters over the durable log.

## Config

```yaml
- id: codewhale-fleet
  name: '@deepseek-ai/dsh-codewhale-fleet'
  config:
    maxRounds: 2
    maxTranscriptChars: 8000
    tickMs: 1000            # tick cadence for observer roles
    maxTurnSeconds: 300     # 0 disables; turn-budget inject
    maxSilenceSeconds: 120  # 0 disables; silence-budget steer
    maxTurns: 50            # 0 disables; turn-cap cancel
    maxRepeatedToolCalls: 3 # 0 disables; repeat-budget steer
    roles:
      - id: reviewer
        instructions: Review the response against the task.
      - id: observer
        cadence: tick
        instructions: Watch for stalls and loops.
```

`cadence` defaults to `turn-stopping` (reviewer); a role with `cadence: tick` is an observer. Budget values are plain numbers; `0`, negative, or `NaN` disables the rule.

## Model Experience

### Reviewer feedback

#### What the model sees

A fix verdict steers the reviewer's feedback as a user-role plugin message. Pass verdicts and the ledger events themselves are log-only: the agent is not told about clean reviews.

#### Token effect

Conditional, per review round: one reviewer call per role, each sending the task plus the latest assistant response (capped at `Config.maxTranscriptChars`), plus the steered feedback when a fix is requested. Tick observers add zero tokens (deterministic counters only).

#### KV Cache effect

Independent of the main session's request prefix: reviewer calls are separate one-shot requests on their own routes. The steered feedback enters the main request as a new user-role message.

### Observer intervention

#### What the model sees

A level-1 turn-budget notice is injected for the next step; level-2 (silence, repeat) and level-3 (turn cap) interventions steer or cancel at the inbox boundary, like a user interjection. Every intervention also appends a durable `fleet/review` event with `kind: 'observer'`, `verdict: 'fix'`, the rule id in the record, and the delivered text in `feedback`.

#### Token effect

Zero tokens for the observer itself (no model call). Only the delivered reminder/steer text enters the session as retained history, at most once per rule per turn (and at most one steer/cancel per session).

#### KV Cache effect

Steering terminates the reusable request prefix for that agent until the turn settles; subsequent steps start a new prefix.

## Known Limitations and Deferred Work

- **Reviewers see the transcript, not the workspace** — a reviewer receives the task and the latest response text only; file diffs and tool results are not included.
- **One fix at a time** — when several roles request fixes, only the first role's feedback is steered; the rest are logged and surface in `/fleet status`.
- **No per-run prompt section** — the fleet run is not announced through a system-prompt section; the steered task and review feedback carry the model-visible facts.
- **Tick observation is in-memory** — per-session observer state is not persisted; a resumed session re-accumulates budgets.
- **Fleet-level run cancel is per-session** — the TS fleet's tick cancels the one worker whose session is the run; multi-node sibling policy belongs to the Rust `codewhale_new` fleet.
