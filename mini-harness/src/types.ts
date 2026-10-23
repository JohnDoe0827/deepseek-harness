/** One argument a tool advertises to the model. */
export interface ToolParameter {
  /** JSON-like kind the model must send. */
  type: 'string' | 'number'
  /** Sentence the model reads when choosing arguments. */
  description: string
}

/** A tool stored by `ctx.tools`. */
export interface ToolDefinition {
  /** Stable name the model uses in a tool call. */
  name: string
  /** Sentence the model reads when choosing the tool. */
  description: string
  /** Arguments this tool accepts. */
  parameters: Record<string, ToolParameter>
  /**
   * Run the tool.
   *
   * @param args — arguments that already match `parameters`.
   * @returns the text shown back to the model.
   */
  execute(args: Record<string, string | number>): string | Promise<string>
}

/** One model request to run a tool. */
export interface ToolCall {
  /** Id that ties the later tool message to this call. */
  id: string
  /** `ToolDefinition.name` to run. */
  name: string
  /** Arguments the model supplied. */
  arguments: Record<string, string | number>
}

/** One message the model and the loop exchange. */
export interface LlmMessage {
  /** Who produced the message. */
  role: 'user' | 'assistant' | 'tool'
  /** Text body. */
  content: string
  /** Set on a tool message to the call it answers. */
  toolCallId?: string
  /** Set on an assistant message that requested tools. */
  toolCalls?: readonly ToolCall[]
}

/** What `ctx.llm.complete` returns for one step. */
export interface LlmResult {
  /** Assistant text. Empty when `toolCalls` is non-empty. */
  text: string
  /** Tool calls to run before the next model step. Empty when the turn is done. */
  toolCalls: readonly ToolCall[]
}
