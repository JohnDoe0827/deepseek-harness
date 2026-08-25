# Agent Note: Restore the TUI as the default dsh surface

Status: implemented

English | [中文](2026-08-25-restore-tui-as-default-surface.zh.md)

## Problem

The 2026-08-04 removal left Web as the only shipped interactive surface; bare `dsh` required `--profile` and the product default was the browser UI. The user requested the default be the terminal UI instead, reversing the removal.

## Decision

Restore `packages/ui/tui` from the removal commit's parent (commit `10bb9cbf4a^`), re-integrate it against the current core, and make the TUI the default surface of the `dsh` launcher.

The reintegration spans four layers, each following an existing pattern rather than inventing a new one:

- **Package**: `packages/ui/tui` is restored and registered in the workspace build (tsconfig paths/references, knip, workspace-constraints extras, the `pi-tui@0.80.7` patch in `patches/` and `patchedDependencies`). Source imports and service names are aligned to today's core: `@deepseek-ai/cordis`, `dsh-user-questions` (service `userQuestions`), `dsh-compaction`, `ModelSelection`/`installModelSelection` (replacing `AgentLlmTarget`/`installAgentLlmTarget`), payload-style agent events (`agent/inbox/claimed|inserted|discarded`, `agent/status|error|disposed`, `agent/pre-step` instead of `agent/prompt-submit`), `SessionReferenceResolver`/`SessionQueryEngine`/`SkillRegistry`, and the current session event vocabulary (`compaction/start|end`, `turn/end` reason map, no `steering/message`).
- **Surface bundle**: the new `@deepseek-ai/dsh-tui-app` package mirrors `dsh-web-app`: a `cordis.patch.yml` surface layer over `dsh-base` (pre-created `main` agent, TUI rows, storage/projection-cache/session-reference/tool-ask-user/tmux-context, process-local `session-query-sqlite` path) plus a `startup` provider that parses `--resume`, mints the session identity, and provides the launcher-owned boot slots (`configuredAgentIdentities`, `tuiGoodbyeMessage`, `tuiResumeHost`, `launcherSessionQueryPath`). Rows that read launcher-owned values inject `tuiStartup`.
- **Profile + launcher**: `tui` joins `PROFILE_TEMPLATES` as `base + tui-app`; bare `dsh` (no `--profile`, no subcommand) boots the `tui` profile; `dsh tui` is a hardcoded alias mirroring `dsh web`; `dsh -h` still prints launcher help. `apps/cli` ships `@deepseek-ai/dsh-tui-app` so the template resolves from the installation.
- **Docs**: README, docs/user/guide (index.md is now the TUI guide; the Web guide moved to web.md), apps/cli README and CLI behavior reference, and the site mapping (`website/docs.ts`) all lead with the TUI; Web is an explicit `dsh web` entry.

This note supersedes the "no terminal UI" consequence of the 2026-08-04 removal note. The archived TUI implementation notes remain frozen records, not current authority.

## Verification

- `pnpm exec tsc -b packages/ui/tui packages/bundle/tui-app apps/cli packages/boot/app-boot` exits 0.
- `apps/cli/tests/args.spec.ts` passes 6/6 (default-profile routing, `tui` alias, passthrough boundary).
- `packages/ui/tui` unit suite runs 179/186 green. The 7 remaining failures are behavioral fixtures written against the pre-removal core (goal-change rendering, one steering-badge hint transition, two compaction replay markers, one transcript rendering, one reference-card render, one error/disposal notice): each is a fixture expectation, not a compile or launcher regression.
- Remaining gates not run in this change: full `tsconfig.host.json` typecheck (test fixtures still carry some old-shape members the host aggregate would flag), doc-sync catalog regeneration for the new bundle rows, and a keyless PTY boot smoke of the assembled `tui` profile.

## Alternatives considered

**Fresh TUI instead of restoration.** Rejected: the removed front end was product quality three weeks prior, and restoration plus re-integration gives a shippable default today; a rewrite can iterate on top.

**Keep `dsh` requiring `--profile`.** Rejected: the user-facing default was the request; Web remains one explicit entry among equals.

## Consequences

Bare `dsh` now boots the terminal UI: the `tui` profile (`base + tui-app`) becomes the default, `dsh tui` aliases it explicitly, and Web is reached through the explicit `dsh web` entry, so an installation without a browser still gets a first-class interactive surface. The new `@deepseek-ai/dsh-tui-app` surface bundle ships with `apps/cli`, so the default template resolves from the installation. Documentation, the user guide (index.md now the TUI guide, the Web guide at web.md), and the site mapping lead with the TUI. This note supersedes the "no terminal UI" consequence of the 2026-08-04 removal note; the archived TUI implementation notes remain frozen records, not current authority. Follow-up gates remain as recorded under Verification: the full `tsconfig.host.json` typecheck (test fixtures still carry old-shape members), doc-sync catalog regeneration for the new bundle rows, and a keyless PTY boot smoke of the assembled `tui` profile.
