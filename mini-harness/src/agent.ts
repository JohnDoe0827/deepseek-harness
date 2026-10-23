import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './scripted-llm.ts'
import type {} from './session.ts'
import type {} from './system-prompt.ts'
import type {} from './tools.ts'
import type { LlmResult } from './types.ts'

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
    this.ctx.session.append({ type: 'turn/start' })
    this.ctx.session.append({ type: 'user/message', text: prompt })
    for (let step = 1; step <= this.config.maxSteps; step++) {
      this.recordSystem()
      const result = await this.ctx.llm.complete(
        this.ctx.session.messages(),
        this.ctx.tools.definitions(),
        this.ctx.session.systemText(),
      )
      this.ctx.emit('agent/step', step, result)
      this.ctx.session.append({ type: 'assistant/message', text: result.text, toolCalls: result.toolCalls })
      if (result.toolCalls.length === 0) {
        this.ctx.session.append({ type: 'turn/end', text: result.text })
        return result.text
      }
      for (const call of result.toolCalls) {
        this.ctx.session.append({ type: 'tool/call', call })
        const output = await this.ctx.tools.execute(call)
        this.ctx.session.append({ type: 'tool/result', callId: call.id, output })
        this.ctx.emit('tools/result', call, output)
      }
    }
    throw new Error(`agent stopped after ${this.config.maxSteps} steps`)
  }

  /** Log the system prompt when its text differs from the log's latest copy. */
  private recordSystem(): void {
    const text = this.ctx.systemPrompt.text()
    if (text === this.ctx.session.systemText()) return
    this.ctx.session.append({ type: 'system/message', text })
  }
}

export const name = 'agent'

export const inject = ['tools', 'llm', 'session', 'systemPrompt']

/**
 * Mount the loop once its services exist.
 *
 * @param ctx — the plugin context.
 * @param config — validated loop settings.
 */
export function apply(ctx: Context, config: Config) {
  ctx.plugin(AgentService, config)
}
