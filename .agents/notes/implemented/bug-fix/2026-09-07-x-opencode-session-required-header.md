# Agent Note: Send the x-opencode-session header on OpenCode Go requests

Status: implemented

English | [中文](2026-09-07-x-opencode-session-required-header.zh.md)

## Problem

The OpenCode Go managed-inference API operator requires every request to carry an `x-opencode-session` header — a stable per-conversation id they use for routing and prompt-cache optimization — and stated that requests without it would error from 2026-09-05. Their telemetry measured near-zero header presence across harness versions, so every `opencode-go/*` model request from the harness was heading for a hard failure. The adapter's request headers were only authorization, content type, accept, and attribution; nothing carried a session identity.

## Decision

The `dsh-llm-opencode-go` adapter sends `x-opencode-session` on every chat-completions request. The value is the request's harness session id (`GenerateOptions.sessionId`, which the agent loop, compaction summarizer, and session-title provider all stamp with the durable per-conversation id), so repeated requests of one conversation — resumes included — present the same stable id the operator's routing and cache reuse key off. A request outside a harness conversation (no session id) carries a fresh UUID per request, so the required header is always present without inventing identity shared across unrelated requests. This is the documented `sessionId` mapping hook in `dsh-llm` ("adapters may map it to model-hidden transport metadata"); no core llm contract changed.

## Alternatives considered

**Send the header only when a session id exists.** Rejected: the operator's requirement is unconditional — any request without the header errors after the cutoff, and nothing in `GenerateOptions` promises a session id on hand-built calls.

**One static fallback id shared by all sessionless requests.** Rejected: the header names a *conversation*; a shared value would merge unrelated conversations into one provider-side routing/cache namespace.

**A config option to supply or disable the value.** Rejected: presence and per-conversation semantics are a fixed provider contract, not a deployment-varying choice, and no consumer needs to override them.

## Consequences

Every real conversation request now carries its stable session id, which both keeps requests valid after the operator's cutoff and lets OpenCode Go reuse prompt-cache state across a conversation's turns. Sessionless requests stay valid with a per-request UUID at the cost of no cache reuse (they had none before). Unit tests lock both behaviors: two requests of one conversation share the exact header value, and a sessionless request sends a UUID. The README's KV Cache effect documents the header. Refines the request wiring of the [OpenCode Go provider adapter](../feature/2026-08-14-opencode-go-provider.md) and its [direct-connection transport](../feature/2026-08-21-opencode-go-direct-connection.md) — neither covered request headers.
