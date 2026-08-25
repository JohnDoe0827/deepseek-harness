/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-opencode-go`.
 * @module @deepseek-ai/dsh-llm-opencode-go/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-opencode-go'

/** Cordis companion plugin name. */
export const name = 'llm-opencode-go-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this transport adapter owns no durable package-local
 * event stream; the llm service owns the request lifecycle, and wire-shape
 * tests cover the mapping.
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
