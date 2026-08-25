/**
 * OpenCode Go chat-completions wire format. OpenCode Go serves the
 * OpenAI-compatible surface of OpenCode Zen's Go subscription at
 * `https://opencode.ai/zen/go/v1`: `POST /chat/completions` accepts the
 * standard OpenAI streaming request, and chunks carry the standard OpenAI
 * delta vocabulary (`content`, `reasoning_content` when the routed model
 * exposes it, `tool_calls`, `finish_reason`, `usage`). Types only.
 *
 * @module dsh-llm-opencode-go/types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: a single string of user input. */
export interface WireUserMessage {
  role: 'user'
  content: string
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One replayed assistant tool call. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Assistant-role history message. Text-less turns send `content: ""` — never
 * null — because some OpenAI-compatible gateways reject null content on
 * tool-call turns; `tool_calls` rides alongside when the turn called tools.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string
  tool_calls?: WireToolCall[]
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/** One entry of the request `tools` array. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One delta of one streamed choice. */
export interface WireDelta {
  role?: 'assistant'
  content?: string | null
  /** Reasoning text some routed models expose on the OpenAI surface. */
  reasoning_content?: string | null
  tool_calls?: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

/** One streamed choice. */
export interface WireChoice {
  delta: WireDelta
  finish_reason?: string | null
}

/** Token accounting from the streamed `usage` payload. */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One SSE data payload of the chat-completions stream. */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
}

/** Error envelope of a non-2xx response body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
