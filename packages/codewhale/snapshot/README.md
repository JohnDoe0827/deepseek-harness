# @deepseek-ai/dsh-codewhale-snapshot

English | [中文](README.zh.md)

CodeWhale-style turn snapshots for DeepSeek Harness: after each turn the plugin copies the session's workspace (minus `Config.excludes`) into `Config.dir/<sessionId>/<seq>/` when its content fingerprint changed, and the `/undo` and `/restore` commands roll the workspace back to an earlier snapshot.

A snapshot is a full copy, so `undo`/`restore` are exact regardless of intervening edits; the fingerprint skip keeps unchanged turns from growing the store. Snapshots are taken asynchronously after `turn/end`, one in-flight snapshot per session. Restores are durable `snapshot/restore` events and the restored state is announced to the agent through an injected notice, so the model never works against a workspace it was not told about.

## Composition

The plugin hooks `session/event` for `turn/end` and registers `/undo` and `/restore` through `ctx.commands`:

- `/undo` — restore the snapshot before the latest change (error when only one snapshot exists).
- `/restore` — list snapshots (sequence, source turn, file count, time).
- `/restore <seq>` — restore a named snapshot.

The snapshot store layout is `<dir>/<sessionId>/<seq>/` with a `meta.json` sidecar per snapshot. `Config.workspace` overrides the session working directory as the snapshot root; `Config.excludes` skips entries whose path segment matches (for example `node_modules`, `.git`).

## Model Experience

### Snapshot and restore notices

#### What the model sees

A restore injects one notice: `The workspace was restored to snapshot <seq> (taken after turn <turn>).` The snapshot-taking itself is invisible; `snapshot/taken` and `snapshot/restore` are durable log-only events.

#### Token effect

Zero direct tokens for snapshots; one short injected notice per restore.

#### KV Cache effect

Independent: snapshots never touch a request prefix. A restore changes files the model may have read, and the injected notice enters the next request as a new user-role message.

## Known Limitations and Deferred Work

- **Whole-workspace copies** — every changed turn copies the complete workspace (minus excludes); large repositories pay per-turn copy cost. Incremental diffs are deferred.
- **Restore keeps extra files** — files created after a snapshot and absent from it are left in place; restore overwrites and recreates snapshot files only.
- **No snapshot projection** — the Web UI has no snapshot view; `/restore` listing is the only surface.
- **Async snapshots** — a snapshot runs after `turn/end` without blocking the loop; an `/undo` racing an in-flight snapshot may restore a state the snapshot is still writing.
