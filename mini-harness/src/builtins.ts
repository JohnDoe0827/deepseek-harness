import type { Context } from '@deepseek-ai/cordis'
import type {} from './tools.ts'

export const name = 'builtins'

export const inject = ['tools']

/** Register the two tools this sample knows how to run. */
export function apply(ctx: Context) {
  ctx.effect(() => {
    const removeEcho = ctx.tools.register({
      name: 'echo',
      description: 'Return the given text.',
      parameters: {
        text: { type: 'string', description: 'Text to return.' },
      },
      execute(args) {
        return String(args.text)
      },
    })
    const removeAdd = ctx.tools.register({
      name: 'add',
      description: 'Add two numbers.',
      parameters: {
        a: { type: 'number', description: 'Left operand.' },
        b: { type: 'number', description: 'Right operand.' },
      },
      execute(args) {
        return String(Number(args.a) + Number(args.b))
      },
    })
    return () => {
      removeEcho()
      removeAdd()
    }
  })
}
