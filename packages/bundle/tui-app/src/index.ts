/**
 * @deepseek-ai/dsh-tui-app — the terminal-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the terminal-surface glue: it registers the
 * harness-source prompt section so the agent it drives can find its own source.
 * The `--resume` flag family and the launcher-owned session identity arrive
 * through the `tuiStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-tui-app
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * Mount the terminal-surface glue on the booted tree.
 * @param ctx - the profile tree context.
 */
export function apply(ctx: Context): void {
  addHarnessSourceSection(ctx, SOURCE_ROOT)
}
