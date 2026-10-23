# Agent Note: A minimal Cordis harness sits beside the product

Status: implemented

English | [中文](2026-10-23-minimal-cordis-harness.zh.md)

## Problem

The product harness is a large plugin tree: session logs, approval, sandboxing, a web UI, and the model adapter all load together. Someone who wants to see how an agent loop sits on Cordis has to read that tree. The loop itself is a small idea: a tool registry, a model, and a plugin that repeats "ask the model, run the tools" until the model stops.

## Decision

[`mini-harness/`](../../../../mini-harness/README.md) is a Cordis application. [`vendor/cordis/bin.js`](../../../../vendor/cordis/bin.js) loads its `cordis.yml`. Five plugins share one context. `tools` stores tool definitions and runs calls. `scripted-llm` turns two user sentences (`add <number> and <number>`, `echo <text>`) into a tool call, and turns a tool result into the final text. `agent` repeats the model and the tools until the model returns no tool calls, or until `maxSteps` (default 4) is spent. `builtins` registers `add` and `echo`, and its disposer removes them when that plugin unloads. `cli` reads one prompt from the command line and prints each step.

The model is the `llm` service. The `scripted-llm` row is the only model entry, so another plugin that provides `llm` replaces it. The directory imports `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` only. No `dsh` profile mounts it.

## Alternatives considered

**A trimmed headless profile.** That composition still loads the product packages, so the file count stays the product's. The sample exists so the loop can be read without those packages.

**An `examples/` leaf.** [examples/](../../../../examples/AGENTS.md) boots the real harness, and each leaf's tests drive that composition. A from-scratch loop there would be held to the product roster.

**One source file.** A single file can print an answer, and it hides that the loop, the tools, and the model are separate plugins that meet through the context.

## Consequences

The sample can drift from the product loop. It is a teaching program: one in-memory prompt, two tools, and a scripted model. Calling a real model means replacing the `llm` plugin. The sample does not grow a session log, approval, a sandbox, or a UI, and product code does not import it.
