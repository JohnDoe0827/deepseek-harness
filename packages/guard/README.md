# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

Behavioral guard plugins watch the agent loop for unproductive patterns and enforce per-call budgets. A guard is a self-contained consumer of core services and extension points, not a swappable capability.

| Package | Role | ctx key |
|---|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Advisory reminders for repeated tool calls | listens on tool and agent events |
| [`timeout-policy/`](timeout-policy/README.md) | Arms per-call tool deadlines as deployment policy | registers a `tools/execute` listener |
| [`observer/`](observer/README.md) | Timeline-independent observer: budget/silence/repeat rules with inject-steer-cancel intervention | `ctx.agents`, durable `observer/notice` events |
| [`context-handoff/`](context-handoff/README.md) | Context-bloat handoff: measures token pressure vs the routed model's window, records a durable `context/handoff` notice and reminds the agent to back up and hand off verbatim | `ctx.tokenMeter`, durable `context/handoff` events |

Reminders travel as `additionalContexts` on the `tools/post-execute` decision and are appended as logged plugin-sourced `user/message` events ([tools](../../docs/subsystems/tools.md)); the timeout split across `dsh-timeout`, capability termination, and this policy layer is recorded in the [timeout-library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md).
