# Agent Note: OpenCode Go requests always connect directly

Status: implemented

English | [中文](2026-08-21-opencode-go-direct-connection.zh.md)

## Problem

OpenCode Zen Go's regional gating keys off the request origin: the latest deepseek-v4-flash builds are hosted in China and require the workspace's "models deployed in China" opt-in, which the service silently flips off when traffic looks overseas. On hosts with an ambient proxy — the common China setup routes everything through a Clash-style proxy with an overseas exit — proxied OpenCode Go requests made the endpoint treat the workspace as overseas, producing intermittent 403 `RegionError`s, while the domestic `deepseek-official` route stayed unaffected. Node's `fetch` ignores environment proxies by default, but that is an accident of defaults: `--use-env-proxy` or a host-installed global dispatcher would silently re-route the requests. The endpoint is also materially more stable over HTTP/2 than over HTTP/1.1 from CN networks (long silent stalls and connection resets on HTTP/1.1, none observed over HTTP/2), and the OpenCode client — which the user reported as rock-solid on the same endpoint and models — uses an HTTP/2-first transport.

## Decision

**The OpenCode Go adapter sends every request through a direct HTTP/2-first got transport.** `got` negotiates HTTP/2 with automatic HTTP/1.1 fallback — the same transport shape as the OpenCode client — and never reads environment proxies, so every request to the OpenCode Go endpoint leaves from the machine's real origin regardless of host proxy wiring. got's ambient retries, redirects, and status-throwing are explicitly disabled: the harness retry policy owns retries, and the adapter's stable error mapping handles status codes. The scope is exactly the opencode-go route: `deepseek-official`, pi-ai providers, and the harness's own web tools keep their ambient transport. `got` becomes a direct dependency of `dsh-llm-opencode-go` (its HTTP/2 support rides http2-wrapper); the previous undici fetch transport is removed.

## Alternatives considered

**A configurable bypass flag.** Rejected: the direct connection is the whole point of the route. The endpoint's regional gating makes a proxied exit a correctness hazard, not a preference, and a knob would re-admit the failure by configuration.

**Keeping the undici fetch transport with an explicit direct dispatcher.** Rejected: undici fetch is HTTP/1.1-only, which is the fragile protocol shape on this route, and guarding the directness needs the dispatcher-override machinery. got delivers directness and HTTP/2 in one maintained transport.

## Consequences

OpenCode Go requests never ride a proxy and negotiate HTTP/2 first, so the endpoint always sees the machine's real origin, the workspace's China-hosted opt-in state stays stable for deepseek models, and the connection shape matches the OpenCode client the user verified as stable. A deployment that can only reach opencode.ai through a proxy cannot use this adapter as-is (documented under Known Limitations). Tests pin the transport contract: a got spy asserts `http2: true` with retries, redirects, and status-throws off, and a behavioral test sets dead proxy environment variables and proves the request still reaches the endpoint. Refines the transport behavior of the [OpenCode Go provider adapter](2026-08-14-opencode-go-provider.md).
