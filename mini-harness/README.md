# Minimal Cordis harness

English | [中文](README.zh.md)

This directory is an agent loop written as Cordis plugins. It uses the vendored framework in `vendor/` and loads none of the DeepSeek Harness product packages.

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
| `src/tools.ts` | `ctx.tools` | Register and execute tools |
| `src/scripted-llm.ts` | `ctx.llm` | Turn a prompt into text or one tool call |
| `src/agent.ts` | `ctx.agent` | Repeat the model and the tools until the model stops calling tools |
| `src/builtins.ts` | | The `add` and `echo` tools |
| `src/cli.ts` | | Read the prompt and print the trace |

`cordis.yml` is the application. `agent.maxSteps` defaults to 4.

## Another model

`ctx.agent` calls `ctx.llm.complete`. A replacement provider is another plugin that registers the `llm` service. Point the `scripted-llm` row in `cordis.yml` at that file.

## Check

```sh
node --import tsx --test src/loop.test.ts
```

The test boots the plugins in process and runs `cordis.yml` through `vendor/cordis/bin.js`.
