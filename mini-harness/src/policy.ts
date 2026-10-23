import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from './tools.ts'

/** Names the waterfall stops before the tool runs. */
export interface Config {
  /** Tool names that return a denial instead of running. */
  deny: string[]
}

export const Config: Schema<Config> = Schema.object({
  deny: Schema.array(String).default([]),
})

export const name = 'policy'

export const inject = ['tools']

/**
 * Stop a denied tool by returning before `next()`.
 *
 * @param ctx — the plugin context.
 * @param config — the deny list.
 */
export function apply(ctx: Context, config: Config) {
  ctx.on('tools/execute', async (call, next) => {
    if (config.deny.includes(call.name)) return `Denied tool: ${call.name}`
    return next()
  })
}
