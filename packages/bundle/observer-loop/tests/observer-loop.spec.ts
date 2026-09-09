/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list that mounts the observer and
 * context-handoff rows with their deployment defaults, so every workspace
 * mounting this profile carries the full resilience loop.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-observer-loop bundle', () => {
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
    expect(rows.map(row => row.id)).toEqual(['observer', 'context-handoff', 'tool-evolve'])
    // Every row's plugin ships as a declared dependency of the bundle, so the
    // profile composer resolves each bare name from the installation closure.
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-observer')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-context-handoff')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-tool-evolve')
  })

  it('shapes each row config for deployment defaults', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]
    const rows = parsed.flatMap(patch => patch.insert ?? [])
    const byId = new Map(rows.map(row => [row.id, row]))
    const observer = byId.get('observer')?.config
    expect(observer?.['maxTurnSeconds']).toBe(300)
    expect(observer?.['maxRepeatedToolCalls']).toBe(3)
    const handoff = byId.get('context-handoff')?.config
    expect(handoff?.['thresholdRatio']).toBe(0.6)
    expect(handoff?.['keepCycles']).toBe(3)
    expect(handoff?.['scrubMs']).toBe(86_400_000)
    // The backup dir row is present and resolves at compose time to the
    // harness home (a !!js expression node), so every project shares one
    // storage root without per-workspace config.
    expect(handoff?.['backupDir']).toBeTruthy()
  })
})
