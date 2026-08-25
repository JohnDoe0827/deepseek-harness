import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectWorkspaceFiles,
  excludedPath,
  fingerprintsEqual,
  resolveConfig,
  snapshotSeqDirs,
} from '../src/index.ts'

describe('resolveConfig', () => {
  it('resolves dir and workspace to absolute paths', () => {
    const cfg = resolveConfig({ dir: 'store', excludes: ['.git'], workspace: 'ws' })
    expect(cfg.dir.endsWith('store')).toBe(true)
    expect(cfg.workspace?.endsWith('ws')).toBe(true)
  })

  it('requires dir and non-empty excludes entries', () => {
    expect(() => resolveConfig({ dir: '', excludes: [] })).toThrow('non-empty string `dir`')
    expect(() => resolveConfig({ dir: 'store', excludes: [''] })).toThrow('non-empty strings')
  })

  it('rejects unknown keys', () => {
    expect(() => resolveConfig({ dir: 'store', excludes: [], extra: 1 } as never))
      .toThrow('unknown key(s) extra')
  })
})

describe('excludedPath', () => {
  it('excludes by path segment at any depth', () => {
    expect(excludedPath('node_modules/pkg/index.js', ['node_modules'])).toBe(true)
    expect(excludedPath('src/node_modules/x.js', ['node_modules'])).toBe(true)
  })

  it('excludes by prefix', () => {
    expect(excludedPath('dist/bundle.js', ['dist'])).toBe(true)
    expect(excludedPath('src/dist/x.js', ['dist'])).toBe(true)
  })

  it('keeps unrelated paths', () => {
    expect(excludedPath('src/app.ts', ['node_modules', 'dist'])).toBe(false)
  })
})

describe('fingerprintsEqual', () => {
  const a = [
    { path: 'a.ts', mtimeMs: 1, size: 2 },
    { path: 'b.ts', mtimeMs: 3, size: 4 },
  ]

  it('accepts identical inventories in the same order', () => {
    expect(fingerprintsEqual(a, [
      { path: 'a.ts', mtimeMs: 1, size: 2 },
      { path: 'b.ts', mtimeMs: 3, size: 4 },
    ])).toBe(true)
  })

  it('rejects changed content, order, or length', () => {
    expect(fingerprintsEqual(a, [{ path: 'a.ts', mtimeMs: 1, size: 2 }])).toBe(false)
    expect(fingerprintsEqual(a, [{ path: 'a.ts', mtimeMs: 9, size: 2 }, { path: 'b.ts', mtimeMs: 3, size: 4 }])).toBe(false)
    expect(fingerprintsEqual(a, [{ path: 'b.ts', mtimeMs: 3, size: 4 }, { path: 'a.ts', mtimeMs: 1, size: 2 }])).toBe(false)
  })
})

describe('snapshotSeqDirs', () => {
  it('reads nothing from a missing directory', async () => {
    expect(await snapshotSeqDirs('/nonexistent/dsh-snapshot-seq')).toEqual([])
  })
})

describe('collectWorkspaceFiles', () => {
  it('walks a workspace in stable order and skips excluded entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-snapshot-walk-'))
    try {
      await mkdir(join(root, 'src', 'deep'), { recursive: true })
      await writeFile(join(root, 'a.txt'), 'a')
      await writeFile(join(root, 'src', 'b.txt'), 'bb')
      await writeFile(join(root, 'src', 'deep', 'c.txt'), 'ccc')
      await mkdir(join(root, 'node_modules'))
      await writeFile(join(root, 'node_modules', 'skip.js'), 'x')

      const files = await collectWorkspaceFiles(root, ['node_modules'])
      expect(files.map(file => file.path)).toEqual(['a.txt', 'src/b.txt', 'src/deep/c.txt'])
      expect(files.every(file => file.size > 0)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
