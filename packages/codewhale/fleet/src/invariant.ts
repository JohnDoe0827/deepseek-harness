/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-codewhale-fleet`.
 * @module @deepseek-ai/dsh-codewhale-fleet/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-codewhale-fleet'

/** Cordis companion plugin name. */
export const name = 'codewhale-fleet-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The structured reviewer verdicts, as a runtime set for input narrowing. */
const FLEET_VERDICTS = new Set(['pass', 'fix'])
/** The run-closing reasons, as a runtime set for input narrowing. */
const FLEET_END_REASONS = new Set(['clean', 'fixes-exhausted'])

/** Validate one fleet ledger event before it reaches the durable log. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'fleet/run') {
    const { id, roles } = event.data
    if (typeof id !== 'string' || id.length === 0) fail('fleet/run id must be a non-empty string')
    if (!Number.isSafeInteger(roles) || roles < 0) fail('fleet/run roles must be a non-negative safe integer')
  } else if (event.type === 'fleet/review') {
    const { id, role, verdict, feedback, chars } = event.data
    if (typeof id !== 'string' || id.length === 0) fail('fleet/review id must be a non-empty string')
    if (typeof role !== 'string' || role.length === 0) fail('fleet/review role must be a non-empty string')
    if (!FLEET_VERDICTS.has(verdict)) fail(`fleet/review carries unknown verdict ${JSON.stringify(verdict)}`)
    if (typeof feedback !== 'string') fail('fleet/review feedback must be a string')
    if (!Number.isSafeInteger(chars) || chars < 0) fail('fleet/review chars must be a non-negative safe integer')
  } else if (event.type === 'fleet/end') {
    const { id, reason } = event.data
    if (typeof id !== 'string' || id.length === 0) fail('fleet/end id must be a non-empty string')
    if (!FLEET_END_REASONS.has(reason)) {
      fail(`fleet/end carries unknown reason ${JSON.stringify(reason)}`)
    }
  }
}

/** Install validation for loaded and newly appended fleet ledger events. */
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
 * Register the fleet invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
