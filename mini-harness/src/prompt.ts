import type { Context } from '@deepseek-ai/cordis'
import type {} from './system-prompt.ts'
import type {} from './tools.ts'

export const name = 'prompt'

export const inject = ['systemPrompt', 'tools']

/** Put the current tool schemas into the system prompt. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.systemPrompt.contribute(() => ctx.tools.schemaText()))
}
