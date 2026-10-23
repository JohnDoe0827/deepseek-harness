import { Service, type Context } from '@deepseek-ai/cordis'
import type { LlmMessage, LlmResult, ToolDefinition } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: ScriptedLlm
  }
}

const ADD = /^add\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)$/i
const ECHO = /^echo\s+([\s\S]+)$/i

/**
 * A stand-in model.
 *
 * It understands two user sentences: `add <number> and <number>`, and
 * `echo <text>`. After a tool result it returns that result as the answer.
 * Any other user sentence gets a short usage line. Replace this plugin to
 * call a real model; `ctx.agent` only needs `complete`.
 */
class ScriptedLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Produce the next assistant step.
   *
   * @param messages — history projected from the session log, oldest first.
   * @param tools — definitions the model may call.
   * @param _system — system prompt text recorded in the log for this step.
   * @returns text, or one tool call.
   */
  complete(messages: readonly LlmMessage[], tools: readonly ToolDefinition[], _system: string): LlmResult {
    const last = messages.at(-1)
    if (last === undefined) return { text: '', toolCalls: [] }
    switch (last.role) {
      case 'tool':
      case 'assistant':
        return { text: last.content, toolCalls: [] }
      case 'user':
        return replyToUser(last.content, tools)
      default:
        return assertNever(last.role)
    }
  }
}

/** Map one user sentence onto text or a single tool call. */
function replyToUser(content: string, tools: readonly ToolDefinition[]): LlmResult {
  const text = content.trim()
  const add = ADD.exec(text)
  const left = add?.[1]
  const right = add?.[2]
  if (left !== undefined && right !== undefined && tools.some(tool => tool.name === 'add')) {
    return {
      text: '',
      toolCalls: [{
        id: 'call-add',
        name: 'add',
        arguments: { a: Number(left), b: Number(right) },
      }],
    }
  }
  const echo = ECHO.exec(text)
  const echoed = echo?.[1]
  if (echoed !== undefined && tools.some(tool => tool.name === 'echo')) {
    return {
      text: '',
      toolCalls: [{
        id: 'call-echo',
        name: 'echo',
        arguments: { text: echoed.trim() },
      }],
    }
  }
  return {
    text: 'Ask me to add two numbers, or to echo some text.',
    toolCalls: [],
  }
}

/** Close the message-role union. */
function assertNever(value: never): never {
  throw new Error(`unexpected message role: ${String(value)}`)
}

export const name = 'scripted-llm'

/** Mount the scripted model. */
export function apply(ctx: Context) {
  ctx.plugin(ScriptedLlm)
}
