# Agent Note: A minimal Cordis harness sits beside the product

Status: implemented

English | [中文](2026-10-23-minimal-cordis-harness.zh.md)

## Problem

The product harness is a large plugin tree: session logs, approval, sandboxing, a web UI, and the model adapter all load together. Someone who wants to see how an agent loop sits on Cordis has to read that tree. The loop itself is a small idea: a tool registry, a model, and a plugin that repeats "ask the model, run the tools" until the model stops. Harness 0.2.1 also makes the session log the source of model history, lets tools contribute system-prompt text, and runs each tool through a `tools/execute` waterfall that a listener can stop by returning before `next()`.

## Decision

[`mini-harness/`](../../../../mini-harness/README.md) is a Cordis application. [`vendor/cordis/bin.js`](../../../../vendor/cordis/bin.js) loads its `cordis.yml`. The plugins share one context. `session` is one in-memory append-only log, and model history is a projection of it. `systemPrompt` joins sections that other plugins contribute. `prompt` contributes `tools.schemaText()` and injects both `systemPrompt` and `tools`, because a fiber that reads `ctx.tools` lists `tools` in `inject`. `tools` stores definitions and runs each call through the `tools/execute` waterfall. `policy` returns `Denied tool: <name>` before `next()` when the name is in `deny` (default empty, so every tool runs). `scripted-llm` turns two user sentences (`add <number> and <number>`, `echo <text>`) into a tool call, and turns a tool result into the final text. It receives the logged system text and leaves that text unread. `agent` appends the turn, records the system text when it changes, and repeats the model and the tools until the model returns no tool calls, or until `maxSteps` (default 4) is spent. `builtins` registers `add` and `echo`, and its disposer removes them when that plugin unloads. `cli` reads one prompt from the command line and prints each step.

The model is the `llm` service. The `scripted-llm` row is the only model entry, so another plugin that provides `llm` replaces it. The directory imports `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` only. No `dsh` profile mounts it. Saved session files, an approval service, a sandbox, and a UI stay in the product.

## Alternatives considered

**A trimmed headless profile.** That composition still loads the product packages, so the file count stays the product's. The sample exists so the loop can be read without those packages.

**Mounting the 0.2.1 product packages.** Those packages carry profiles, durable JSONL session generations, desktop and web UI, a sandbox, an approval service, and subagents. The three mechanisms above are the part worth copying into a program that stays small.

**An `examples/` leaf.** [examples/](../../../../examples/AGENTS.md) boots the real harness, and each leaf's tests drive that composition. A from-scratch loop there would be held to the product roster.

**One source file.** A single file can print an answer, and it hides that the loop, the tools, and the model are separate plugins that meet through the context.

## Consequences

The sample can drift from the product loop. It is a teaching program: one in-memory log, two tools, a system prompt built from tool schemas, a deny list on the tool waterfall, and a scripted model. Calling a real model means replacing the `llm` plugin. Product code does not import the sample.
