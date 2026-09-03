# @deepseek-ai/dsh-observer

A timeline-independent agent observer: it runs on its own clock and its own fact stream — the durable `session/event` broadcast, live `agent/*` lifecycle events, and the `tool/call` records — and evaluates user-configured rules (turn budget, silence budget, turn cap, repeated tool calls) against those observed facts. When a rule fires it intervenes at escalating strength through the same inbox boundaries a user would use:

1. **inject** — queue a model-visible reminder for the next step (weak; current work continues);
2. **steer** — redirect the turn with concrete feedback (medium; the agent answers it like a user interjection);
3. **cancel** — stop the agent with a hook-sourced cancellation cause (strong; the durable `turn/end` records the observer as the reason).

Every intervention appends a durable `observer/notice` session event, so the log reconstructs exactly what the observer did and why. The observer never drives the agent; it only reads facts and submits intervention requests.

## Config

```yaml
- id: observer
  name: '@deepseek-ai/dsh-observer'
  config:
    tickMs: 1000              # default; observer's own evaluation cadence
    maxTurnSeconds: 300       # default; turn budget before a level-1 inject
    maxSilenceSeconds: 120    # default; no-progress budget before a level-2 steer
    maxTurns: 50              # default; session turn cap before a level-3 cancel
    maxRepeatedToolCalls: 3   # default; identical tool-call run before a level-2 steer
```

Config values are plain numbers; every rule is disabled cleanly by setting it to a non-finite or zero value (the plugin treats those as "no rule").

## Semantics

- **The observer is per-session and in-memory.** It keys rule state by the live `Session` (a `WeakMap`), so a disposed session drops its state automatically and a resumed session starts fresh.
- **Rules fire once per active turn.** After a rule fires for a turn, it will not fire again until the next `turn/start`. This prevents the tick from hammering the agent with the same notice.
- **Progress is measured from durable events.** Every `session/event` except `todo/write`, `request/header`, `request/context`, and `session/end-seed` counts as progress and refreshes the silence budget. A real stall therefore produces no progress events and eventually trips the silence rule.
- **The repeat chain is derived from `tool/call`** — the raw `arguments` JSON string is deep key-sorted into a canonical key, so argument objects differing only in property order count as identical. A call identical to the previous tracked call increments the run; a different call resets it.
- **Steering happens once per session.** After the first level-2+ intervention, further notices append to the log but no second steer is queued (unless the agent is cancelled), so the observer does not drown a session in repeated interjections.

## Intervention delivery

`observer/notice` is durable (model-visible ⇒ logged). The delivered text (inject or steer content; empty for a cancel) is included in the notice so the log and derived history agree. Cancellation uses `agent.cancel({ kind: 'hook', reason: 'observer <rule>: <reason>' })`, which the session records as an aborted turn-end with the observer's cause.

## Model Experience

### Level-1 inject (turn budget)

#### What the model sees

At the first turn-budget firing, that agent receives the reminder below on its next step. No tool schema is added.

```markdown
Observer: turn <n> has exceeded the <budget>s budget. If you are blocked, say so explicitly or change approach instead of continuing silently.
```

#### Token effect

Zero tokens before the firing. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Level-2 steer (silence budget / repeated tool)

#### What the model sees

Steering reaches the nearest step like a user interjection and opens a fresh step for it.

```markdown
Observer: no progress observed for <silent>s. Report concrete next steps or the blocking condition; do not continue silently.
```

```markdown
Observer: the identical tool call has repeated <count>×. Inspect the latest result; choose a different action, different arguments, or finish the task.
```

#### Token effect

Each steer is retained history; the observer fires at most once per rule per turn.

#### KV Cache effect

Steering terminates the reusable request prefix for that agent until the turn settles; subsequent steps start a new prefix.

## Known Limitations and Deferred Work

- **In-memory only** — observation state is not persisted; a resumed session starts fresh and re-accumulates budget counters.
- **Exact-match repeat detection** — near-identical tool calls (a tweaked path, reordered-but-equal args still normalize; white-space-only differences inside a string do not) evade the repeat chain. Fuzzy matching is rejected pending evidence of need.
- **No LLM-driven evaluation yet** — rules are deterministic counters against the observed facts. An LLM judge that evaluates whether the *intent* is being served (like `dsh-codewhale-fleet` reviewer roles) is a natural extension: plug into the same fact stream, emit `observer/notice` verdicts, reuse the same three intervention levels.
- **One steering cap per session** — after the first level-2+ intervention, later rule firings only append notices. Raise the cap if a deployment wants repeated redirection.