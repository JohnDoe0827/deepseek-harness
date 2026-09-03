/**
 * Invariant companion coverage for @deepseek-ai/dsh-observer: a hook-caused
 * turn end must have a preceding level-3 notice in the same session.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as ObserverInvariant from '../src/invariant.ts'

async function mount(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('observer-invariant'))
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ObserverInvariant)
  return { ctx, session }
}

describe('observer invariant', () => {
  it('accepts a hook-caused turn end that follows a level-3 notice', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('observer/notice', {
        rule: 'turn-cap',
        level: 3,
        reason: 'session reached 3 turns',
        text: 'Observer: stopping.',
      })
      session.append('turn/start', { turn: 4 })
      session.append('turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'observer turn-cap: session reached 3 turns' } } })
    }).not.toThrow()
  })

  it('rejects a hook-caused turn end without a preceding level-3 notice', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('turn/start', { turn: 5 })
      session.append('turn/end', { turn: 5, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'observer turn-cap: fake' } } })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-observer',
    }))
  })

  it('ignores non-hook turn ends entirely', async () => {
    const { session } = await mount()

    expect(() => {
      session.append('turn/start', { turn: 6 })
      session.append('turn/end', { turn: 6, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 7 })
      session.append('turn/end', { turn: 7, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    }).not.toThrow()
  })
})
