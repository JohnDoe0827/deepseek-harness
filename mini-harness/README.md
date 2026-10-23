# Minimal Cordis harness

English | [中文](README.zh.md)

This directory is an agent loop written as Cordis plugins. It uses the vendored framework in `vendor/` and loads none of the DeepSeek Harness product packages. Three ideas from harness 0.2.1 are here in small form: an append-only session log, a system prompt that tools contribute to, and a `tools/execute` waterfall a policy plugin can stop.

## Run

From this directory:

```sh
node --import tsx ../vendor/cordis/bin.js add 2 and 3
```

The process prints:

```text
step 1: add {"a":2,"b":3}
tool add -> 5
step 2: 5
5
```

`echo hello` returns `hello`. Any other prompt returns `Ask me to add two numbers, or to echo some text.`

## Plugins

| File | Service | Role |
|---|---|---|
| `src/session.ts` | `ctx.session` | Append-only log; model history is a projection of it |
| `src/system-prompt.ts` | `ctx.systemPrompt` | Collect prompt sections and join them |
| `src/tools.ts` | `ctx.tools` | Register tools and run them through `tools/execute` |
| `src/prompt.ts` | | Contribute each tool's schema to the system prompt |
| `src/scripted-llm.ts` | `ctx.llm` | Turn a prompt into text or one tool call |
| `src/builtins.ts` | | The `add` and `echo` tools |
| `src/policy.ts` | | Deny named tools by returning before `next()` |
| `src/agent.ts` | `ctx.agent` | Repeat the model and the tools until the model stops calling tools |
| `src/cli.ts` | | Read the prompt and print the trace |

`cordis.yml` is the application. `agent.maxSteps` defaults to 4. `policy.deny` defaults to an empty list, so every registered tool runs.

## Session, prompt, and tools

The log is the source of what the model sees. `agent` appends `turn/start`, `user/message`, `system/message`, `assistant/message`, `tool/call`, `tool/result`, and `turn/end`. `session.messages()` rebuilds the user, assistant, and tool messages from that log. The system text is passed beside those messages. The log stays in memory for one process.

`prompt` registers a system-prompt section that calls `tools.schemaText()`. A fiber that reads `ctx.tools` lists `tools` in `inject`. `prompt` injects `systemPrompt` and `tools`, so the section stays valid when the agent renders it.

`tools.execute` is the `tools/execute` waterfall. `policy` listens and, for a name in `deny`, returns `Denied tool: <name>` without calling `next()`. The denial is logged as the tool result, and the scripted model returns that text.

## Another model

`ctx.agent` calls `ctx.llm.complete`. A replacement provider is another plugin that registers the `llm` service. Point the `scripted-llm` row in `cordis.yml` at that file. The scripted model receives the system text and leaves it unread. The log still records that text.

## Check

```sh
node --import tsx --test src/loop.test.ts
```

The test boots the plugins in process and runs `cordis.yml` through `vendor/cordis/bin.js`.
