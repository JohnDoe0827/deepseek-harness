/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-observer`.
 * @module @deepseek-ai/dsh-observer/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-observer'

/** Cordis companion plugin name. */
export const name = 'observer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Track the most recent level-3 notice per session and verify the ordering
 * contract: a turn whose `turn/end` records an observer hook cancellation must
 * have a preceding level-3 `observer/notice` in the same session. The observer
 * appends its cause before canceling, so a hook-sourced aborted turn without
 * that notice is an ordering violation. A level-1/2 notice does not satisfy
 * this contract (only a cancel announces a level-3 stop).
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const latestLevel3 = new WeakMap<Session, boolean>()

  /** Returns the offending turn on violation, else `undefined`. */
  function observe(session: Session, event: SessionEvent): number | undefined {
    switch (event.type) {
      case 'observer/notice':
        latestLevel3.set(session, event.data.level === 3)
        return undefined
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'aborted' && reason.reason.kind === 'hook'
          && reason.reason.reason.startsWith('observer ')) {
          const ok = latestLevel3.get(session) === true
          latestLevel3.delete(session)
          return ok ? undefined : event.data.turn
        }
        return undefined
      }
      default:
        return undefined
    }
  }

  // Replay existing sessions first, then verify live appends.
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) {
      const turn = observe(session, event)
      if (turn !== undefined) {
        fail(`turn ${turn} aborted by observer hook without a preceding observer/notice level 3 in the same session`)
      }
    }
  }

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const turn = observe(session, event)
    if (turn !== undefined) {
      fail(`turn ${turn} aborted by observer hook without a preceding observer/notice level 3 in the same session`)
    }
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
