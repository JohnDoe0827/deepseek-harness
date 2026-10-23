import type { Context } from '@deepseek-ai/cordis'
import type {} from './agent.ts'
import type {} from './tools.ts'

export const name = 'cli'

export const inject = ['agent']

const USAGE = 'usage: node --import tsx ../vendor/cordis/bin.js <prompt>'

/** Read one prompt from the command line and print the loop's trace. */
export function apply(ctx: Context) {
  ctx.on('agent/step', (step, result) => {
    if (result.toolCalls.length === 0) {
      console.log(`step ${step}: ${result.text}`)
      return
    }
    for (const call of result.toolCalls) {
      console.log(`step ${step}: ${call.name} ${JSON.stringify(call.arguments)}`)
    }
  })
  ctx.on('tools/result', (call, output) => {
    console.log(`tool ${call.name} -> ${output}`)
  })

  const fromArgv = process.argv.slice(2).join(' ').trim()
  const prompt = fromArgv !== '' ? fromArgv : (process.env.MINI_PROMPT ?? '').trim()
  if (prompt === '') {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  void ctx.agent.run(prompt).then((answer) => {
    console.log(answer)
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
