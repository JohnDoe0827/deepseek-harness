# Use the TUI

English | [中文](index.zh.md)

Run `dsh` in a terminal to open the full-screen terminal UI (TUI) on the invoking directory, which is also the agent's workspace: filesystem and shell tools resolve from it. Sessions persist under the Harness home, so `/resume` reaches every workspace.

## Configure a model

`dsh` resolves the DeepSeek route from the credential store: set `DEEPSEEK_API_KEY` in the environment, in the invoking directory's `.env`, or in the Harness home's `.env` (`~/.dsh/.env` by default), then run `dsh`. Use `/model` inside the TUI to switch the provider or model for later requests.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Run a task

Type a prompt and press Enter:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The TUI asks before operations that require approval under the active permission policy. Press `Ctrl+C` while a turn is running to cancel it; press it again when idle to exit.

## Sessions

Every session is persisted in the invoking directory's workspace. The TUI prints the command that resumes the session when it exits, and `/resume` lists persisted sessions across workspaces. Re-enter one later with:

```sh
dsh --resume <id>
```

The TUI restores the transcript and enters the resumed session's own directory, so filesystem and shell tools again resolve from it.

## Continue

- [Configure models](./providers.md)
- [Use the Web UI](./web.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
