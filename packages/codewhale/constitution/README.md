# @deepseek-ai/dsh-codewhale-constitution

English | [中文](README.zh.md)

CodeWhale-style constitution for DeepSeek Harness: a workspace file declares standing instructions injected into every model request and write holds that reject workspace file mutations regardless of approval posture.

The constitution file (`Config.file`, resolved against each session's working directory) is read and validated lazily on every use, so edits take effect at the next write decision or request assembly with no reload command. A missing file means no constitution; a malformed one fails the write decision or the request assembly loudly instead of being ignored.

## Composition

The plugin registers the `codewhale:constitution` system-prompt section (order 60) and the two fs decision waterfalls (`fs/write-intent`, `fs/edit-intent`) with `prepend: true`, so this policy runs before the observation policy regardless of mount order. A held write throws `FsError` with `FS_PERMISSION_DENIED` from the same slot the tool pipeline already maps for the model. The `/constitution` command (composed through `ctx.commands`) prints the active file, instruction size, and write holds.

### Constitution file

A YAML mapping with two optional keys:

```yaml
instructions: |
  Standing guidance for every request in this workspace.
writeHolds:
  - '**/secrets/**'
  - package-lock.json
```

`writeHolds` entries are glob patterns matched against workspace-relative paths (`dot: true`, so explicit patterns like `.env` match). An entry matching a directory's descendants needs the recursive form (`**/secrets/**`). The instructions section also lists the active holds so the model knows which paths are held before it tries to write them.

## Model Experience

### Constitution instructions and write holds

#### What the model sees

The `codewhale:constitution` section text: the file's `instructions` verbatim, plus one line naming the active write holds when any exist. A session without a constitution file contributes an empty section.

#### Token effect

Conditional, per request: the section text is the constitution file's size, unchanged across requests until the file changes.

#### KV Cache effect

Prefix-stable across requests while the file is unchanged; editing the file changes the request prefix and invalidates cache reuse for the next request.

## Known Limitations and Deferred Work

- **Shell writes bypass the holds** — the waterfalls guard the model-facing fs tools (`tool-fs`, `tool-str-replace-editor`); a shell command that writes a held path is not blocked. Path-level denial inside the sandbox policy is deferred.
- **Per-session files only** — the constitution resolves against each session's working directory; a workspace-agnostic home-level constitution is not supported.
- **Sync file reads** — the prompt section renders synchronously, so the constitution file is read with blocking I/O once per assembly (cached by mtime within a boot).
