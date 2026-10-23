import { Service, type Context } from '@deepseek-ai/cordis'
import type { LlmMessage, ToolCall } from './types.ts'

/** One durable fact. Model history is derived from these, not stored beside them. */
export type SessionEvent =
  | { type: 'turn/start' }
  | { type: 'turn/end', text: string }
  | { type: 'system/message', text: string }
  | { type: 'user/message', text: string }
  | { type: 'assistant/message', text: string, toolCalls: readonly ToolCall[] }
  | { type: 'tool/call', call: ToolCall }
  | { type: 'tool/result', callId: string, output: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    session: SessionService
  }

  interface Events {
    /** A fact was appended. @mode emit */
    'session/event'(event: SessionEvent): void
  }
}

/** The one in-memory log for this process. */
class SessionService extends Service {
  private readonly events: SessionEvent[] = []

  constructor(ctx: Context) {
    super(ctx, 'session')
  }

  /**
   * Append one fact and announce it.
   *
   * @param event — the fact to keep.
   */
  append(event: SessionEvent): void {
    this.events.push(event)
    this.ctx.emit('session/event', event)
  }

  /**
   * Facts in append order.
   *
   * @returns the log.
   */
  log(): readonly SessionEvent[] {
    return this.events
  }

  /**
   * Latest system text recorded in the log.
   *
   * @returns that text, or `''` when none has been recorded.
   */
  systemText(): string {
    let text = ''
    for (const event of this.events) {
      if (event.type === 'system/message') text = event.text
    }
    return text
  }

  /**
   * Model history projected from the log.
   *
   * System text stays on {@link systemText}. Turn markers and `tool/call` rows
   * stay in the log because the assistant message already carries the calls.
   *
   * @returns the user, assistant, and tool messages, oldest first.
   */
  messages(): LlmMessage[] {
    const messages: LlmMessage[] = []
    for (const event of this.events) {
      switch (event.type) {
        case 'user/message':
          messages.push({ role: 'user', content: event.text })
          break
        case 'assistant/message':
          messages.push(event.toolCalls.length === 0
            ? { role: 'assistant', content: event.text }
            : { role: 'assistant', content: event.text, toolCalls: event.toolCalls })
          break
        case 'tool/result':
          messages.push({ role: 'tool', content: event.output, toolCallId: event.callId })
          break
        case 'turn/start':
        case 'turn/end':
        case 'system/message':
        case 'tool/call':
          break
        default:
          return assertNever(event)
      }
    }
    return messages
  }
}

/** Close the session-event union. */
function assertNever(value: never): never {
  throw new Error(`unexpected session event: ${String(value)}`)
}

export const name = 'session'

/** Mount the in-memory log. */
export function apply(ctx: Context) {
  ctx.plugin(SessionService)
}
