# @deepseek-ai/dsh-llm-opencode-go

English | [中文](README.zh.md)

OpenCode Go (the OpenCode Zen Go subscription) chat-completions adapter for the DeepSeek Harness LLM seam: registers the `opencode-go` provider route on `ctx.llm` against the OpenAI-compatible surface at `https://opencode.ai/zen/go/v1`. Sessions can switch their default model to an `opencode-go/*` model in the same picker that lists DeepSeek and any other registered provider.

## Composition

The plugin registers one provider route (`opencode-go`, display name "OpenCode Go") plus a configurable-provider entry, so the web Models page can write an API key and per-provider settings. Connection facts resolve per request: the `llm-opencode-go:` user-settings section (`$DSH_HOME/settings.yaml`) layers over the `cordis.yml` entry config, and the API key resolves through the credential seam from the `OPENCODE_GO_API_KEY` reference (default; `apiKeyEnv` renames it). An edited base URL, catalog, or key reaches the very next request without a restart; the endpoint also falls back to `$OPENCODE_GO_BASE_URL` from a trusted environment layer.

The adapter's requests always connect directly over an HTTP/2-first transport: got negotiates HTTP/2 and falls back to HTTP/1.1 automatically (the same transport shape as the OpenCode client), and never reads environment proxies, so OpenCode Go traffic always leaves from the machine's real origin. The endpoint's regional gating — the China-hosted deepseek opt-in — keys off the request origin, and a proxied exit from an overseas IP silently flips that state, so this route is deliberately exempt from any proxy the host configures. Other providers and the harness's own web tools keep their ambient transport.

The adapter is text-only (`UNSUPPORTED_CONTENT` for image blocks) and does not declare a reasoning-effort ladder: the OpenAI-compatible surface does not document a stable effort vocabulary, so an explicit `reasoningEffort` fails with `UNSUPPORTED_REASONING_EFFORT` instead of being silently dropped. The advisory model catalog defaults to the Go subscription's coding lineup (`deepseek-v4-flash`, `deepseek-v4-pro`, `kimi-k3`, `qwen3.6-plus`) and is overridable through `models`.

## Model Experience

### Request route

#### What the model sees

Nothing beyond the ordinary request: the adapter serializes the harness conversation to OpenAI chat-completions messages and streams the response back as text, reasoning, and tool-call blocks. The `opencode-go` provider and model come from the session's logged route.

#### Token effect

Zero direct tokens; the request is the conversation itself. Usage reported by the endpoint is mapped to harness token counts (cache reads subtracted).

#### KV Cache effect

Independent: a `llm-opencode-go:` settings edit changes the request prefix only when it changes the endpoint or model; the provider's own cache behavior applies to repeated requests.

## Known Limitations and Deferred Work

- **OpenAI surface only** — OpenCode Go's Anthropic-native `/messages` models are not routed; the adapter serves the chat-completions surface that carries the coding lineup.
- **Always direct** — requests bypass any proxy the host configures; a deployment that can only reach opencode.ai through a proxy cannot use this adapter as-is.
- **No reasoning ladder** — `reasoningEffort` requests fail loudly rather than mapping to an undocumented wire vocabulary.
- **Text-only** — image content is rejected; multimodal models on the surface are not served.
- **Shared adapter pipeline** — the fetch/SSE transport and provider-registration shapes mirror `dsh-llm-deepseek`; extracting a shared OpenAI-compatible adapter layer is deferred.
