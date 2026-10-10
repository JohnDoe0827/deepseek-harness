# Agent Note: Preserve tool-call identity across streaming placeholders

Status: implemented

English | [中文](2026-08-27-empty-tool-call-stream-identity.zh.md)

## Problem

After the harness boots, every model turn that emits a tool call could degrade into a **nameless call loop**: the assembled assistant message carried a `tool-call` block with `id: ''` and `name: ''`, the tool runtime rejected it with `unknown tool ""` (`UNKNOWN_TOOL`), and the model repeatedly retried the same invalid call — each retry failing the same way, burning tokens against a tool that can never route. The user-visible symptom is "the harness keeps triggering a tool-is-empty error after startup".

The root cause is three stacking defects on the streaming path:

1. **Wire translation** (both `dsh-llm-opencode-go` and `dsh-llm-deepseek`): compliant OpenAI-style streams put `id`/`name` on the first `tool_calls` frame and omit them on later argument fragments. The OpenCode Go gateway (observed live) instead echoes explicit `null`/`""` placeholders on every fragment. The translators tested `!== undefined` before assigning, so those placeholders **overwrote** the first-frame identity with `null`/`""`.

2. **`BlockAssembler.push`** (`dsh-llm`): a `tool-call-delta` assigned `partial.toolCallId = chunk.id` unconditionally, so a later empty-id delta clobbered the captured id; the name path already used a truthy guard but the id path did not.

3. **`BlockAssembler.push` block-end**: a `block-end` replaced `partial.block` wholesale with the provider's assembled block. Since the translators closed blocks through `closeBlock()` with `?? ''` fallbacks, the block-end carried the now-empty id/name and erased the values the deltas had captured.

## Decision

Three changes, narrow at each boundary:

1. **Both `translate.ts` adapters** only advance `block.callId`/`block.name` when the wire value is a present, non-empty string. Placeholder `null`/`""` fragments no longer overwrite first-frame identity.

2. **`BlockAssembler.push` tool-call-delta** only assigns `partial.toolCallId` when `chunk.id` is truthy and non-empty — the same floor the name path already applied.

3. **`BlockAssembler.push` block-end** keeps the provider's block for non-tool-call types, but for a `tool-call` fills an empty `id`/`name` from the captured delta values (falling back to the existing generated `call-{index}` id). A provider that closes a call with no identity cannot erase what the deltas saw.

## Alternatives considered

**Only fix the gateways' translation.** Rejected: the assembler is the canonical assembly algorithm shared by every adapter; the same nameless-close shape can arrive from any future provider, and the delta-path id overwrite was a latent bug regardless of the current gateway's wire behavior.

**Drop nameless tool-call blocks entirely.** Rejected: a call with an unknown identity still has arguments and a turn intent; recording it as an `UNKNOWN_TOOL` result keeps the session log faithful, while the identity-preserving fix keeps the call routable in the first place.

## Consequences

A streaming tool call retains the identity its first frame carried, no matter how a gateway spells later argument fragments. The nameless-call retry loop observed at startup no longer occurs; unit tests lock the behavior at both the translator and assembler floors, and a live headless run that previously looped on `unknown tool ""` now completes in one tool call. The prior registration/assembly gate (2026-08-26-empty-tool-name-gate) remains the last-resort floor for schemas; this note fixes the streaming side that defeats it at the call site.