/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-codewhale-snapshot`.
 * @module @deepseek-ai/dsh-codewhale-snapshot/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-codewhale-snapshot'

/** Cordis companion plugin name. */
export const name = 'codewhale-snapshot-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one snapshot payload against the durable shape. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'snapshot/taken') {
    const { seq, turn, files } = event.data
    if (!Number.isSafeInteger(seq) || seq <= 0) fail('snapshot/taken seq must be a positive safe integer')
    if (!Number.isSafeInteger(turn) || turn < 0) fail('snapshot/taken turn must be a non-negative safe integer')
    if (!Number.isSafeInteger(files) || files < 0) fail('snapshot/taken files must be a non-negative safe integer')
  } else if (event.type === 'snapshot/restore') {
    const { seq, turn } = event.data
    if (!Number.isSafeInteger(seq) || seq <= 0) fail('snapshot/restore seq must be a positive safe integer')
    if (turn !== null && (!Number.isSafeInteger(turn) || turn < 0)) {
      fail('snapshot/restore turn must be null or a non-negative safe integer')
    }
  }
}

/** Install validation for loaded and newly appended snapshot events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the snapshot invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
