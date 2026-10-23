import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPromptService
  }
}

/** Prompt sections the model sees. Each contributor is re-read at render time. */
class SystemPromptService extends Service {
  private readonly parts: Array<() => string> = []

  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  /**
   * Add a section until the returned disposer runs.
   *
   * @param render — current text of the section.
   * @returns a disposer that removes the section.
   */
  contribute(render: () => string): () => void {
    this.parts.push(render)
    return () => {
      const index = this.parts.indexOf(render)
      if (index >= 0) this.parts.splice(index, 1)
    }
  }

  /**
   * The prompt text for the next model call.
   *
   * @returns the non-empty sections, separated by newlines.
   */
  text(): string {
    return this.parts.map(render => render()).filter(part => part !== '').join('\n')
  }
}

export const name = 'system-prompt'

/** Mount prompt assembly. */
export function apply(ctx: Context) {
  ctx.plugin(SystemPromptService)
}
