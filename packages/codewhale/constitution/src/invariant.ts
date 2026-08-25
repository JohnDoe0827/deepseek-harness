/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-codewhale-constitution`.
 * @module @deepseek-ai/dsh-codewhale-constitution/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-codewhale-constitution'

/** Cordis companion plugin name. */
export const name = 'codewhale-constitution-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the constitution is deployment policy — a workspace
 * file rendered into a prompt section and enforced at the fs decision
 * waterfalls. It appends no durable session events and owns no mutable
 * relation to check; the fs and session packages own the shapes it consumes.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
