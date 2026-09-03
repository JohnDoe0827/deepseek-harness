---
name: dsh-context-handoff
description: Use when a worked session is approaching its context or output budget (the transcript is bloated, each turn costs an ever-larger prefix, or a compact answer still re-sends the whole history) and the work should continue in a fresh session instead of being compressed away — detect the bloat, back up the project and the conversation, write a handoff note, and prompt the user to open the fresh session. Complements dsh-compaction-blocked or manual flow when compaction is not wanted because the full record must survive verbatim.
---

# DSH Context Handoff

Hand off a bloated session to a fresh one **without losing the record**: the project is backed up with full history, the conversation is exported verbatim, and a handoff note tells the next session exactly where work stands. This is the durable alternative to compaction when the complete transcript or repository must survive byte-for-byte.

Read [the session-telemetry note](../../notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md) and the [observer note](../../notes/implemented/feature/2026-08-29-timeline-independent-agent-observer.md) before judging bloat: the session log is the authoritative record, and the token meter prices what a fresh request would actually send.

## Detect bloat

Decide **before** the conversation is unrecoverable — the trigger is a durable fact, not a feeling:

1. **Token pressure** — when the harness exposes a token meter (`ctx.tokenMeter.measure(session)`), the authoritative signal is `totalTokens` vs the model's `contextWindow`:

   - `totalTokens` at or above **60% of `contextWindow`** (DeepSeek 1M-token windows: ~600k) → **handoff now**.
   - At **40–60%** → warn the user and plan the handoff; do not start new large work.
   - Compaction's own threshold is `thresholdRatio × contextWindow`; handoff triggers at the same pressure point **when the user wants the verbatim record, not a summarization**.

2. **Budget erodement** — every turn re-sends the full history: when the last several assistant messages each required the complete prefix (each turn's cost ≈ the whole session), the marginal answer no longer earns its prefix. Two or more full re-sends per user message is the practical line.

3. **Raw transcript size** — the exported conversation JSONL (uncompressed) exceeding **~10 MB**, or the session directory's `session.jsonl.zstd` exceeding **~3 MB**, is the same signal as (1) for sessions without a token meter.

A session that trips (1) or (3) is past the point of comfortable work; run the handoff once, cleanly, instead of repeatedly trimming.

## Back up the project

Capture the repository exactly as the next session will need it. For a git worktree:

1. **Full-history bundle** (clone-able in one step):

```sh
cd /path/to/project
git bundle create /home/lwss/backups/<project>-master.bundle --all
```

Bundle all refs (`--all`), not just `master`; a bare clone from the bundle restores everything.

2. **Source tarball** (working tree minus `.git`, `node_modules`, `lib`, and known junk):

```sh
cd /path/to/parent
tar --exclude='.git' --exclude='node_modules' --exclude='lib' \
  -czf /home/lwss/backups/<project>-src.tar.gz <project>
```

Add `--exclude` patterns for the project's known untracked junk (`c1`, `t[0-9]*`, `op*`, `dsh-session-*`, `.tmp`, `.landing-staging` — prune by inspecting `git status --short` first; never exclude real work).

3. **Verify** the backups landed (size sanity vs the previous backup) and, when a git remote like `priv` exists, `git push <remote> <branch>` so the bundle and the remote agree.

## Export the conversation

The harness exposes the live session record through the environment:

```sh
echo "$DSH_SESSION_JSONL"      # absolute path of this session's zstd JSONL
echo "$DSH_SESSION_ID"         # durable session id
```

Copy the session record into the backups directory under a stable name; decompress the zstd so the raw transcript is greppable and survives without the harness:

```sh
mkdir -p /home/lwss/backups
cp "$DSH_SESSION_JSONL" /home/lwss/backups/<session-id>-conversation.jsonl.zstd
zstd -d -f /home/lwss/backups/<session-id>-conversation.jsonl.zstd \
  -o /home/lwss/backups/<session-id>-conversation.jsonl
```

If `DSH_SESSION_JSONL` is unset, locate the newest `session-*/session.jsonl.zstd` under `$DSH_HOME/sessions/<project-dir>/` and export that.

## Write the handoff note

Create `HANDOFF-<topic>.md` in the backups directory (never inside the repo; the next session reads it from disk without a checkout). Required sections, modeled on the observer-session handoff:

- **一句话目标** — the immutable objective, one line.
- **已交付成果** — table of (commit / content); every shipped change with its commit hash and what it does.
- **关键文件** — paths the next session must open first.
- **仓库状态** — branch, upstream remote, uncommitted leftovers (say exactly what NOT to commit), untracked junk the next session may ignore.
- **备份** — the bundle/tarball/JSONL names and what each restores.
- **若继续（可选下一步）** — numbered, concrete, actionable next steps.
- **环境备注** — working directory, test command, disk, style conventions.

Every commit referenced in the table must exist (`git log --oneline` to confirm) and every file path must resolve (`test -f` / `test -d`).

## Prompt the fresh session

End with a short, self-contained handoff message the user can paste into the fresh session — one line of objective + the handoff note path:

> 读取 /home/lwss/backups/HANDOFF-<topic>.md 和 <session>-conversation.jsonl，继续 <topic> 工作。

Keep the message is 2–3 lines: read the two files, continue the objective. Do not dump backup paths into it; the note holds them.

## Guardrails

- **Never run the handoff twice**: after writing the note and exporting the JSONL, finish the current session's immediate work and tell the user to refresh; do not start new work in the bloated session.
- **Never commit the backups or the note into the repo**; they live in `/home/lwss/backups/` only.
- **Never include the conversation JSONL in the source tarball**; they are separate artifacts.
- **Never let the handoff silence a real failure**: if the project's current state has uncommitted work-in-progress that the next session must finish, say so in 仓库状态; the backup preserves it, it is not discarded.
- **Coordinated with compaction**: choose handoff when the user needs the verbatim record or the project state, and compaction when a summarized continuation is acceptable. Do not run both on the same boundary.