# @deepseek-ai/dsh-tool-evolve

English | [中文](README.zh.md)

The model-facing `evolve` tool runs a fixed foreground workflow that grows from a **seed** through explicit iterations into formed **nodes**. Each round opens a fresh child (no parent conversation, no prior child session) with the immutable seed, the previous node, per-round **nutrients**, and the active **mutation**; the child performs concrete work and returns one structured node. On a `regress` verdict the round's changes are discarded (the child undoes its workspace edits) and the next round carries the node's mutation to branch differently — DNA-style evolution over the [workflow engine](../workflow/README.md) and [subagent seam](../../subagent/subagent/README.md).

## Contract

`evolve({ seed, iterations, nutrients?, nodeMode?, mutateOnRegress? })` waits for the entire run. The deployment config's `maxIterations` is both the default and a ceiling on a call override. Every round starts one child through `subagentProvider`; that provider must exist, support structured output, and report `inheritsParentContext: false`. The configured provider rides `WorkflowStartRequest.subagentProvider`; the resolved iteration cap rides `maxTotalAgents`.

Each child receives the seed (immutable), its round and iteration count, workspace/report-mode instructions, the previous node, the round nutrients, and the active mutation. Nodes carry `verdict: continue | complete | blocked | regress`, a non-empty `summary` and `work`, evidence strings, and a `mutation` string (may be empty). `nodeMode: 'report'` forbids workspace writes; the default `'workspace'` performs concrete work and, on `regress`, instructs the child to undo its changes with `git checkout -- .` (or equivalent) before returning the node.

The successful terminal tool result is `complete`, `blocked`, or `budget-limited`, with the last node and iteration count. The canonical envelope is `{ runId, agentsStarted, result }`; the renderer says a worker reported the outcome, not independent certification. `maxNodeChars` bounds a node's serialized form (validated inside the workflow and again at the consumer boundary); `maxResultChars` bounds only the rendered text.

An ordinary child failure produces an error naming the failed round and retaining the last successful node when one exists. Evolve does not retry that round; cancellation is also an error, and partial output is never success.

## Lifecycle and cancellation

The caller's agent is the parent of every fresh child. `exec.signal` enters the workflow engine and is bridged to `run.cancel()`. The tool awaits `run.result` and calls `run.dispose()` in `finally`.

## Render intent

The pending call is a `generic` card titled `evolve`; the seed is its `rawInput`. The result keeps the generic card.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every round. |
| `maxIterations` | `256` | Default and deployment ceiling for one evolve run. |
| `maxNodeChars` | `16384` | Serialized ceiling for one node handoff. |
| `maxResultChars` | `16384` | Rendered-text ceiling for the parent-facing result. |
| `nodeMode` | `workspace` | `workspace` writes into the shared workspace; `report` is structured-only. |

## Known Limitations and Deferred Work

- **Node persistence is caller-owned** — the tool returns nodes in the canonical result; a durable per-round node ledger (e.g. `.evolve/nodes/`) is a follow-up, not yet part of this slice.
- **Backtracking relies on the child's tools** — the script has no filesystem; a regress round depends on the child actually undoing its workspace changes (prompted, not enforced).