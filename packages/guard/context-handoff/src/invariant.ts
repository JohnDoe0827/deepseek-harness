/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-context-handoff`.
 * @module @deepseek-ai/dsh-context-handoff/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-handoff'

/** Cordis companion plugin name. */
export const name = 'context-handoff-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Verify the measure-then-notice ordering contract: every `context/handoff`
 * event must record a pressure measurement at or above its own threshold, so
 * a notice is only written after a real boundary crossing. A handoff event
 * whose `totalTokens` is below its `thresholdTokens` is an ordering violation
 * (a notice fabricated without measurement).
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  /** Returns a violation summary on failure, else `undefined`. */
  function observe(event: SessionEvent): string | undefined {
    if (event.type !== 'context/handoff') return undefined
    const data = event.data
    if (data.totalTokens >= data.thresholdTokens) return undefined
    return `context/handoff at seq ${event.seq} recorded totalTokens ${data.totalTokens} `
      + `below its thresholdTokens ${data.thresholdTokens} (measure-then-notice violated)`
  }

  // Replay existing sessions first, then verify live appends.
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) {
      const violation = observe(event)
      if (violation !== undefined) fail(violation)
    }
  }

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    const violation = observe(event)
    if (violation !== undefined) fail(violation)
  }, { global: true })
}, { inject: ['sessions'] as const })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
