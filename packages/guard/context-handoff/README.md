# @deepseek-ai/dsh-context-handoff

A context-bloat handoff observer that **does the handoff automatically**. It runs on its own clock (a `setInterval` independent of the agent timeline), measures each live session's token pressure with the token meter, and when `totalTokens` reaches `thresholdRatio` of the routed model's `contextWindow`, it:

1. bundles the project's full history (`git bundle --all`),
2. archives the working tree (tarball excluding build/dependency residue),
3. exports the conversation JSONL from the session record,
4. writes a `HANDOFF-<topic>.md` note for the fresh session,
5. appends a durable `context/handoff` notice carrying every artifact path,
6. injects a model-visible reminder telling the user to open a fresh session.

The fresh session mounts this observer and `dsh-observer` with a bumped `cycle`, so the monitoring loop continues verbatim instead of compacting the record away.

The `dsh-context-handoff` skill documents the manual fallback (when the plugin is not mounted or a backup step needs intervention).

## Config

```yaml
- name: '@deepseek-ai/dsh-context-handoff'
  config:
    tickMs: 10000            # default; observer's own evaluation cadence
    thresholdRatio: 0.6      # default; fraction of contextWindow that trips a handoff
    cycle: 0                 # default; handoff cycle number, bumped by each fresh session
    backupDir: ~/backups     # required in practice; where artifacts land
    projectDir: .            # required in practice; project root to archive
    topic: session-handoff   # default; artifact/note name stem
    excludePatterns: [.git, node_modules, lib]  # default; tarball excludes
    backupRunner: <fn>       # optional; inject a test/different executor
```

- `tickMs` — how often the observer re-measures live sessions (ms).
- `thresholdRatio` — the pressure fraction of the routed model's `contextWindow` that trips one `context/handoff` notice. With a 1M-token window and the default `0.6`, the boundary is 600k tokens.
- `cycle` — the handoff generation. The first session runs 0; each fresh session sets it one past the last notice (`handoff cycle + 1`), so the durable record sequences how many generations the monitoring loop has survived.
- `backupDir` — directory for the bundle / tarball / JSONL / note (default `~/backups`).
- `projectDir` — project root whose git history and working tree are archived (default `process.cwd()`, which is the dsh launch directory).
- `topic` — name stem for artifacts (`<topic>.bundle`, `<topic>-src.tar.gz`, `HANDOFF-<topic>.md`, `<topic>-conversation.jsonl`). Default derives from the session id.
- `excludePatterns` — tar `--exclude` patterns for the tarball.
- `backupRunner` — injectable backup executor (the default uses child processes; tests inject an in-memory fake).

The boundary is `Math.floor(contextWindow * thresholdRatio)`. The adapted model must expose its `contextWindow` (`resolveModelInfo`); targets without disclosed capacity are skipped until one is configured.

## Semantics

- **The monitoring loop.** `dsh-observer` guards session hygiene (stalls, loops, budgets) and this observer guards session lifespan (bloat). On a handoff, the durable `context/handoff` notice records the cycle; the fresh session mounts both plugins with `cycle` bumped, so the loop continues across generations. The reminder text tells the agent exactly that.
- **Backup runs automatically, before the notice.** The observer measures (`ctx.tokenMeter.measure`) and only when `totalTokens >= thresholdTokens` runs the backup executor, then appends the notice. The notice carries the paths actually produced (`bundlePath`, `tarballPath`, `jsonlPath`, `notePath`); a backup failure is captured in `error` instead of suppressing the notice.
- **The observer cedes on handoff.** `dsh-observer` consumes the durable `context/handoff` event and stops intervening for that session: once the owner chose a verbatim handoff, the handoff flow owns termination and the hygiene guard cannot cancel or steer against it.
- **Measure then notice, once per session.** Each session trips at most once (`fired` per-session state, dropped on disposal), so the observer never re-backs-up a bloated session.
- **The durable notice is the record of the reminder.** The injected message text is reconstructable from the `context/handoff` event's fields (target, totals, threshold, ratio, reason, cycle, and the artifact paths), satisfying model-visible ⟺ logged.
- **Model capacity is resolved once per target.** `resolveModelInfo` gives the routed model's `contextWindow`; the resulting threshold is cached per `provider/model` key instead of queried every tick.
- **The route comes from the session default.** The observer reads `ctx.agentDefaultModel.currentSelection()`, the same fallback a reviewer role uses, so the measured client matches the model actually serving the session.

## Backup executor

The default `backupRunner`:

- `mkdir -p <backupDir>`,
- `git bundle create <backupDir>/<topic>.bundle --all` (in `projectDir`; a non-git project reports `bundlePath` absent rather than failing),
- `tar -czf <backupDir>/<topic>-src.tar.gz --exclude=... <projectDir>`,
- copies `$DSH_SESSION_JSONL` (when the host exposes it) to `<backupDir>/<topic>-conversation.jsonl`,
- writes the rendered handoff note to `HANDOFF-<topic>.md`.

A git-bundle failure without a JSONL fallback raises; otherwise missing pieces are reflected in the notice's absent path fields.

## Model Experience

### The reminder (past the threshold)

#### What the model sees

At the first threshold crossing, that agent receives the reminder below on its next step. No tool schema is added.

```markdown
Context bloat detected (handoff cycle <N>): session pressure <total> tokens reached the handoff threshold <T> (<ratio> of <window> window for <provider/model>). Backup complete: <bundle>, <tarball>, <jsonl>, note <note>. Tell the user to open a fresh session; the fresh session must mount this observer and the dsh-observer guard with cycle = <N+1> so the monitoring loop continues.
```

#### Token effect

Zero tokens before the crossing. The reminder is retained history for that agent.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Detection is token-heuristic.** Pressure comes from `ctx.tokenMeter`'s fixed estimator (or the latest provider usage anchor), not a live provider accounting of the assembled request. The boundary is a configured ratio, not a provider confirmation; a provider-confirmed overflow path is compaction's `context-overflow` trigger, not this plugin's.
- **Backup assumes host CLIs.** The default runner shells out to `git`, `tar`, and file copy; a deployment without them (or behind a sandbox that blocks child processes) must inject a `backupRunner`.
- **External JSONL export only when the host sets `DSH_SESSION_JSONL`.** Without it the conversation export is skipped (the bundle and tarball still land).
- **One handoff per session.** After the first `context/handoff`, no second backup runs even if pressure keeps climbing beyond the threshold.
- **In-memory state only.** `fired` tracking is keyed by the live `Session`; a resumed session starts fresh and re-arms the threshold.