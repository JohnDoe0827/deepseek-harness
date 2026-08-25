/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that mounts all three plugin
 * rows with their deployment defaults.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-codewhale bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as { insert?: { id?: string }[] }[]).flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['codewhale-constitution', 'codewhale-snapshot', 'codewhale-fleet'])
    // Every row's plugin ships as a declared dependency of the bundle, so the
    // profile composer resolves each bare name from the installation closure.
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-codewhale-constitution')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-codewhale-snapshot')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-codewhale-fleet')
  })

  it('shapes each row config for deployment defaults', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]
    const rows = parsed.flatMap(patch => patch.insert ?? [])
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('codewhale-constitution')?.config?.['file']).toBe('codewhale.constitution.yml')
    expect(byId.get('codewhale-snapshot')?.config?.['excludes']).toContain('node_modules')
    expect((byId.get('codewhale-fleet')?.config?.['roles'] as { id?: string }[])[0]?.id).toBe('reviewer')
  })
})
