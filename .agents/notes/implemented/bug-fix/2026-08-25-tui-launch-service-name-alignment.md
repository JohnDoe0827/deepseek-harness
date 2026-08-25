# Agent Note: TUI launcher boots after service-name and tuiStartup alignment

Status: implemented

English | [中文](2026-08-25-tui-launch-service-name-alignment.zh.md)

## Problem

After the TUI restoration, booting the assembled `tui` profile with `pnpm dsh`
failed at plugin-tree load in two independent ways:

1. `@deepseek-ai/dsh-tui` declared `inject: ['userInteraction']`, but the
   current core ships the ask-user queue as the `userQuestions` service
   (`@deepseek-ai/dsh-user-questions`). The entry stayed `pending (waiting for
   service: userInteraction)` and the boot aborted with "1 entry did not
   activate". The restoration note aligned imports and service usage, but the
   plugin's inject list still carried the pre-removal service name.

2. After fixing that, `packages/bundle/tui-app/cordis.patch.yml` failed for
   the `tui` row: it reads `ctx.tuiStartup.sessionId` in config interpolation
   but did not declare `inject: [tuiStartup]`. The loader rejected the
   expression with "cannot get property \"tuiStartup\" without inject".

## Decision

Two one-line alignment fixes:

- `packages/ui/tui/src/index.ts` now injects `userQuestions` (and its comment
  names the current service); `tests/plugin-shape.spec.ts` expects the same
  list.
- `packages/bundle/tui-app/cordis.patch.yml` gives the `tui` row
  `inject: [tuiStartup]`, matching the `agent-loop` and `session-query-sqlite`
  rows that already read launcher-owned values.

## Verification

- `packages/ui/tui/tests/plugin-shape.spec.ts` and `chat-helpers.spec.ts`
  pass.
- `timeout 10 script -qec "pnpm dsh"` under a PTY renders the TUI (status
  line, `dsh >` prompt, banner) instead of failing; the 10s timeout exits 124
  by design for the resident UI.