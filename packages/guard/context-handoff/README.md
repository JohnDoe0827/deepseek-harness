# @deepseek-ai/dsh-context-handoff

A context-bloat handoff observer: it runs on its own clock (a `setInterval` independent of the agent timeline), measures each live session's token pressure with the token meter, and when `totalTokens` reaches `thresholdRatio` of the routed model's `contextWindow`, it appends a durable `context/handoff` notice and injects a model-visible reminder naming the `dsh-context-handoff` skill. The agent then backs up the project and conversation, writes a handoff note, and prompts the user to open a fresh session — handing off **verbatim** instead of compacting the record away.

This plugin deliberately does not compact and does not touch the filesystem. It only detects the bloat boundary and hands the continuation work to the agent via the skill, keeping the plugin inside the "observe and remind" surface.

## Config

```yaml
- name: '@deepseek-ai/dsh-context-handoff'
  config:
    tickMs: 10000          # default; observer's own evaluation cadence
    thresholdRatio: 0.6    # default; fraction of contextWindow that trips a handoff
```

- `tickMs` — how often the observer re-measures live sessions (ms).
- `thresholdRatio` — the pressure fraction of the routed model's `contextWindow` that trips one `context/handoff` notice. With a 1M-token window and the default `0.6`, the boundary is 600k tokens.

The boundary is `Math.floor(contextWindow * thresholdRatio)`. The adapted model must expose its `contextWindow` (`resolveModelInfo`); targets without disclosed capacity are skipped until one is configured.

## Semantics

- **Measure then notice, once per session.** The observer measures with `ctx.tokenMeter.measure(session)` and only appends `context/handoff` when `totalTokens >= thresholdTokens`. Each session trips at most once (`fired` per-session state, dropped on disposal), so the observer never hammers a bloated session with repeated reminders.
- **The durable notice is the record of the reminder.** The injected message text is reconstructable from the `context/handoff` event's fields (target, totals, threshold, ratio, reason), satisfying model-visible ⟺ logged.
- **Model capacity is resolved once per target.** `resolveModelInfo` gives the routed model's `contextWindow`; the resulting threshold is cached per `provider/model` key instead of queried every tick.
- **The route comes from the session default.** The observer reads `ctx.agentDefaultModel.currentSelection()`, the same fallback a reviewer role uses, so the measured client matches the model actually serving the session.

## Intervention delivery

`context/handoff` is durable and carries the reminder's facts. The observer then calls `agent.inject(message)` to queue the model-visible reminder for the agent's next step; the agent (following the `dsh-context-handoff` skill) backs up the project (`git bundle --all`, source tarball), exports the conversation JSONL, writes `HANDOFF-<topic>.md`, and tells the user to open a fresh session.

## Model Experience

### The reminder (past the threshold)

#### What the model sees

At the first threshold crossing, that agent receives the reminder below on its next step. No tool schema is added.

```markdown
Context bloat detected: session pressure <N> tokens reached the handoff threshold <T> (<ratio> of <window> window for <provider/model>). Load the dsh-context-handoff skill and run its flow: back up the project and conversation, write HANDOFF-<topic>.md, then tell the user to open a fresh session.
```

#### Token effect

Zero tokens before the crossing. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Detection is token-heuristic.** Pressure comes from `ctx.tokenMeter`'s fixed estimator (or the latest provider usage anchor), not a live provider accounting of the assembled request. The boundary is a configured ratio, not a provider confirmation; a provider-confirmed overflow path is compaction's `context-overflow` trigger, not this plugin's.
- **No automatic backup.** The observer reminds; the agent performs the backup and handoff through the skill. A fully automatic file-writing observer is out of scope for this plugin (DSH keeps filesystem work in agent tools, not guard plugins).
- **One reminder per session.** After the first `context/handoff`, no second reminder fires even if pressure keeps climbing beyond the threshold.
- **In-memory state only.** `fired` tracking is keyed by the live `Session`; a resumed session starts fresh and re-arms the threshold.