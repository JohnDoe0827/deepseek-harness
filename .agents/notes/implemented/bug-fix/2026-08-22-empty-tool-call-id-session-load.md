# Agent Note: Accept self-consistent empty tool call ids at session load

Status: implemented

English | [中文](2026-08-22-empty-tool-call-id-session-load.zh.md)

## Problem

A live session whose provider emitted a nameless tool call (`tool_calls` with `id: ""` and no `function.name`) refused to load afterwards. The harness records the degenerate call faithfully — an `assistant/message` block with an empty tool-call id, a `tool/call` event with an empty `callId`, and a `tool/result` "unknown tool" error result whose `source.callId` is also empty — and the log stays internally consistent (call `""` pairs with result `""`). The load-time snapshot validation ([identified immutable message values](../architecture/2026-07-28-identified-immutable-message-values.md)) rejected any empty `callId` as corruption, so the first cold read of such a session failed with `SessionPersistenceCorruptionError` and history became unavailable. The observed trigger was the style dial's off state: after `/rheostat off`, the model emitted the malformed call while investigating the very "unknown tool" noise it caused. The rheostat plugin's off path itself is clean; the malformed call is provider output the harness must stay loadable against.

## Decision

Two changes to `packages/core/session`.

`assertMessageEventShape` now accepts a present-but-empty `callId` on `tool/result` messages: the source must still be `kind: 'tool'` with a string `callId`, and the single `tool-result` block must still cite exactly that callId, so a torn or mismatched write keeps failing. A self-consistent empty callId is replayable end-to-end — provider round-trip, tool pairing, trajectory, and stats all treat it as an opaque string — so refusing it as corruption over-reached the loader's mandate of refusing logs it cannot faithfully interpret.

`Session.append` now enforces the same message-shape invariants as the load and seed paths, before the event enters the log. This closes the asymmetry that wrote the unloadable event in the first place: previously the write path validated only JSON serializability and surface metadata, while the load path additionally validated message shape, so a producer could persist an event no later load would accept. The append site is the earliest resolvable point and matches the method's documented contract that a bad event fails there rather than at a backend flush.

## Alternatives considered

**Repair empty call ids at load.** Rejected: making the result's callId non-empty requires rewriting the paired `tool/call` event and the assistant message's tool-call block to match, which changes the model-visible history and breaks the provider's `tool_call_id` correlation for the turn — a rewrite, not a repair.

**Drop the offending event at load.** Rejected: the model saw that error result; removing it from the derived surface unbalances the tool pairing and the provider transcript.

**Fail the turn when the model emits a nameless tool call.** Rejected: the graceful "unknown tool" error result is cosmetic to users ("不影响结果但影响观感"), while a hard turn failure would abort long-running agent work; making the recorded events loadable is sufficient.

**Keep strict load validation and only fix the producer.** Rejected: the already-stored session stays unloadable, which is the failure this note removes.

## Consequences

Sessions containing self-consistent empty-callId tool results now load, replay, and resume; `load`, `readFrom`, and `inspect` return the complete log. The write path refuses any message shape the load path would refuse, so the two boundaries cannot diverge again; a message-shaped append with a missing identity, wrong role, invalid source, or a tool result without a matching tool source now throws at the append site. Empty callIds remain model-side noise: they surface as an "unknown tool" error result in the log and are sent to the provider as an empty `tool_call_id`, recorded verbatim as emitted.
