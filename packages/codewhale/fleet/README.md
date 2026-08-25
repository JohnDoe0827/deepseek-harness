# @deepseek-ai/dsh-codewhale-fleet

English | [中文](README.zh.md)

CodeWhale-style fleets for DeepSeek Harness: after each turn of an active fleet run, reviewer roles — each with its own provider, model, and reasoning tier — review the task and the agent's latest response through direct LLM calls. A reviewer requesting fixes steers its feedback back into the session so the next step addresses it; when every reviewer passes, the run closes clean. A run closes `fixes-exhausted` after `Config.maxRounds` review rounds.

The session log is the run ledger: `fleet/run`, `fleet/review`, and `fleet/end` events are durable, so status, resume, fork, and replay all fold from the log with no live mirror.

## Composition

The plugin hooks `agent/turn-stopping` (the stop boundary the loop awaits before closing a turn) and registers the `/fleet` command through `ctx.commands`:

- `/fleet run [task]` — start a run; the optional task is steered as a user message.
- `/fleet resume` — re-run the reviews for the active run manually.
- `/fleet` / `/fleet status` — render the ledger.

Each role may name its own `provider`/`model`/`reasoningEffort`; a role naming neither falls back to the session's default route (`ctx.agentDefaultModel`), so a fleet can span vendors in one run or stay on the deployment default. Reviewer output is parsed as a JSON object `{"verdict": "pass" | "fix", "feedback": "..."}`; unparseable output counts as a fix request carrying the raw text, so a review can never masquerade as a pass.

## Model Experience

### Reviewer feedback

#### What the model sees

A fix verdict steers the reviewer's feedback as a user-role plugin message. Pass verdicts and the ledger events themselves are log-only: the agent is not told about clean reviews.

#### Token effect

Conditional, per review round: one reviewer call per role, each sending the task plus the latest assistant response (capped at `Config.maxTranscriptChars`), plus the steered feedback when a fix is requested.

#### KV Cache effect

Independent of the main session's request prefix: reviewer calls are separate one-shot requests on their own routes. The steered feedback enters the main request as a new user-role message.

## Known Limitations and Deferred Work

- **Reviewers see the transcript, not the workspace** — a reviewer receives the task and the latest response text only; file diffs and tool results are not included.
- **One fix at a time** — when several roles request fixes, only the first role's feedback is steered; the rest are logged and surface in `/fleet status`.
- **No per-run prompt section** — the fleet run is not announced through a system-prompt section; the steered task and review feedback carry the model-visible facts.
