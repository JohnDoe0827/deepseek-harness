/**
 * Invariant coverage for @deepseek-ai/dsh-context-handoff: a `context/handoff`
 * notice must always record a pressure measurement at or above its own
 * threshold — measure-then-notice ordering, never a fabricated handoff.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as ContextHandoffInvariant from '../src/invariant.ts'

async function mount(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('context-handoff-invariant'))
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContextHandoffInvariant)
  return { ctx, session }
}

describe('context-handoff invariant', () => {
  it('accepts a notice whose totalTokens meets its threshold', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('context/handoff', {
        target: 'mock/mock',
        totalTokens: 600,
        contextWindow: 1000,
        thresholdTokens: 600,
        ratio: 0.6,
        reason: '600 >= 600 (0.6 of 1000)',
      })
    }).not.toThrow()
  })

  it('rejects a notice recorded below its own threshold', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('context/handoff', {
        target: 'mock/mock',
        totalTokens: 599,
        contextWindow: 1000,
        thresholdTokens: 600,
        ratio: 0.6,
        reason: '599 < 600',
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-context-handoff',
    }))
  })

  it('ignores unrelated events entirely', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/start', { turn: 1 })
    }).not.toThrow()
  })
})
