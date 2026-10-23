import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './scripted-llm.ts'
import type {} from './tools.ts'
import type { LlmMessage, LlmResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService
  }

  interface Events {
    /** The model returned one step. @mode emit */
    'agent/step'(step: number, result: LlmResult): void
  }
}

/** Validated settings for the loop. */
export interface Config {
  /** Model rounds allowed before the loop stops. */
  maxSteps: number
}

export const Config: Schema<Config> = Schema.object({
  maxSteps: Schema.number().min(1).default(4),
})

/**
 * The agent loop: ask the model, run any tool calls, repeat.
 *
 * The loop stops when the model returns no tool calls, or when `maxSteps`
 * is spent on a step that still requested tools.
 */
class AgentService extends Service {
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agent')
  }

  /**
   * Run one prompt to a final text answer.
   *
   * @param prompt — the user text for this run.
   * @returns the model's text once it stops calling tools.
   * @throws when `maxSteps` is spent while a tool call is still outstanding.
   */
  async run(prompt: string): Promise<string> {
    const messages: LlmMessage[] = [{ role: 'user', content: prompt }]
    for (let step = 1; step <= this.config.maxSteps; step++) {
      const result = await this.ctx.llm.complete(messages, this.ctx.tools.definitions())
      this.ctx.emit('agent/step', step, result)
      if (result.toolCalls.length === 0) return result.text
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls })
      for (const call of result.toolCalls) {
        const output = await this.ctx.tools.execute(call)
        this.ctx.emit('tools/result', call, output)
        messages.push({ role: 'tool', content: output, toolCallId: call.id })
      }
    }
    throw new Error(`agent stopped after ${this.config.maxSteps} steps`)
  }
}

export const name = 'agent'

export const inject = ['tools', 'llm']

/**
 * Mount the loop once `tools` and `llm` exist.
 *
 * @param ctx — the plugin context.
 * @param config — validated loop settings.
 */
export function apply(ctx: Context, config: Config) {
  ctx.plugin(AgentService, config)
}
