import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolCall, ToolDefinition } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }

  interface Events {
    /**
     * Run a tool, or stop the chain by returning before `next()`.
     * @mode waterfall
     */
    'tools/execute'(call: ToolCall, next: () => Promise<string>): Promise<string>
    /** A tool finished. The payload is the call and the text returned to the model. @mode emit */
    'tools/result'(call: ToolCall, output: string): void
  }
}

/** Registry of model-callable tools. */
class ToolsService extends Service {
  private readonly items = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /**
   * Store `tool` until the returned disposer runs.
   *
   * @param tool — the definition to keep under `tool.name`.
   * @returns a disposer that removes that name.
   * @throws when `tool.name` is already registered.
   */
  register(tool: ToolDefinition): () => void {
    if (this.items.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.items.set(tool.name, tool)
    return () => {
      this.items.delete(tool.name)
    }
  }

  /**
   * Definitions currently available to the model.
   *
   * @returns the registered tools, in registration order.
   */
  definitions(): readonly ToolDefinition[] {
    return [...this.items.values()]
  }

  /**
   * Tool lines contributed to the system prompt.
   *
   * @returns one line per tool, or `''` when none are registered.
   */
  schemaText(): string {
    return this.definitions().map((tool) => {
      const params = Object.entries(tool.parameters).map(([key, spec]) => `${key}: ${spec.type}`).join(', ')
      return `${tool.name}(${params}) — ${tool.description}`
    }).join('\n')
  }

  /**
   * Run one tool call through the `tools/execute` waterfall.
   *
   * A listener that returns before `next()` replaces the tool. Unknown names
   * and arguments of the wrong kind come back as text so the model can take
   * another step.
   *
   * @param call — the model's request.
   * @returns the tool's text, or an error sentence.
   */
  execute(call: ToolCall): Promise<string> {
    return this.ctx.waterfall('tools/execute', call, () => this.perform(call))
  }

  /** Run `call` after every waterfall listener has delegated. */
  private async perform(call: ToolCall): Promise<string> {
    const tool = this.items.get(call.name)
    if (tool === undefined) return `Unknown tool: ${call.name}`
    const args: Record<string, string | number> = {}
    for (const [key, spec] of Object.entries(tool.parameters)) {
      const value = call.arguments[key]
      if (value === undefined || typeof value !== spec.type) return `${call.name}: ${key} must be a ${spec.type}`
      args[key] = value
    }
    return tool.execute(args)
  }
}

export const name = 'tools'

/** Mount the tool registry. */
export function apply(ctx: Context) {
  ctx.plugin(ToolsService)
}
