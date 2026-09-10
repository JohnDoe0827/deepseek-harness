# Agent Note: A model-facing row added by a later bundle cannot be disabled on Web

Status: implemented

English | [中文](2026-09-10-late-bundle-tool-row-web-boot.zh.md)

## Problem

`dsh web` refused to start on a profile whose `dsh.profile.bundles` listed `@deepseek-ai/dsh-observer-loop`:

```
dsh: plugin tree failed to load: dsh: 1 entry did not activate
@deepseek-ai/dsh-tool-evolve: pending (waiting for service: workflowEngine)
```

The bundle inserted `tool-evolve` as a host-plane row, while the Web bundle disables the host-plane `workflow-worker-thread` row that provides `workflowEngine` and moves every model-facing row behind per-session agent presets ([what stays host-plane once presets own the agent plane](2026-08-10-host-plane-ownership-after-presets.md)). The row could never activate, and the boot audit rejects a settled tree holding a pending entry.

Adding the matching `disabled: true` to the Web bundle cannot repair this: patch lists apply sequentially in `dsh.profile.bundles` order, an id-targeted patch reaches only rows an earlier layer inserted, and a patch that matches nothing is skipped with a warning. Users append bundles through `dsh plugin --profile <name> add`, so a mode bundle is always applied before a bundle added later.

## Decision

Model-facing host-plane rows live in `dsh-base`, the layer every profile applies first. The `tool-evolve` row moved from `dsh-observer-loop` into `dsh-base` beside `tool-ralph`; the Web bundle disables it with its agent-plane siblings; and each shipped preset (`standard`, `code`, `cordis`) mounts its own `tool-evolve` inside the delegation group's isolated `workflowEngine` realm. The tool reaches the TUI and headless surfaces from the host and Web sessions from their preset, and `dsh-observer-loop` is again the two resilience rows (`observer`, `context-handoff`).

## Testing

`apps/cli/tests/web-agent-presets.e2e.ts` asserts both halves on the shipped Web composition: the global tool layer stays empty and the `standard` agent catalog carries `evolve` from its preset. `packages/bundle/base/tests/base.spec.ts`, `packages/bundle/web-app/tests/`, and `packages/bundle/observer-loop/tests/observer-loop.spec.ts` cover the three patch lists. A live `dsh web` boot on a profile listing `@deepseek-ai/dsh-observer-loop` reaches a serving port with no pending entry.

## Alternatives considered

**Add the Web disable without moving the row.** Rejected: the Web layer is applied first for any user-appended bundle, so the patch matches no row, is skipped, and the boot failure remains.

**Re-enable a host `workflow-worker-thread` on Web so the host row can activate.** Rejected: the host row would register `evolve` globally while presets registered it per session — two compositions of one tool, against the empty-global-layer invariant the Web composition test pins.

**Ship the tool only in the presets.** Rejected: the TUI and headless surfaces compose their agent process-wide and mount no preset roster, so they would lose the tool.

## Consequences

Every shipped surface keeps the `evolve` tool — host-plane on TUI and headless, preset-scoped on Web — and a bundle added after a mode bundle can no longer break the Web boot by carrying a model-facing row. The Web bundle's agent-plane section records that a row it disables must be inserted by an earlier layer.
