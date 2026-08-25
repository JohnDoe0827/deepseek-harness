import { describe, expect, it } from 'vitest'
import {
  heldPattern,
  parseConstitution,
  relWorkspacePath,
  resolveConfig,
} from '../src/index.ts'

describe('resolveConfig', () => {
  it('requires a non-empty file', () => {
    expect(() => resolveConfig({ file: '' })).toThrow('non-empty string `file`')
    expect(() => resolveConfig({ file: '  ' })).toThrow('non-empty string `file`')
  })

  it('rejects unknown keys', () => {
    expect(() => resolveConfig({ file: 'c.yml', extra: 1 } as never)).toThrow('unknown key(s) extra')
  })

  it('accepts a plain file path', () => {
    expect(resolveConfig({ file: 'codewhale.constitution.yml' })).toEqual({ file: 'codewhale.constitution.yml' })
  })
})

describe('parseConstitution', () => {
  it('parses an empty document as an empty constitution', () => {
    expect(parseConstitution('', 'c.yml')).toEqual({ instructions: '', writeHolds: [] })
    expect(parseConstitution('# comment only\n', 'c.yml')).toEqual({ instructions: '', writeHolds: [] })
  })

  it('parses instructions and write holds', () => {
    const doc = parseConstitution([
      'instructions: Always run the tests.',
      'writeHolds:',
      '  - "**/secrets/**"',
      '  - package-lock.json',
    ].join('\n'), 'c.yml')
    expect(doc).toEqual({
      instructions: 'Always run the tests.',
      writeHolds: ['**/secrets/**', 'package-lock.json'],
    })
  })

  it('rejects a non-mapping document', () => {
    expect(() => parseConstitution('- a\n- b\n', 'c.yml')).toThrow('c.yml must be a YAML mapping')
  })

  it('rejects unknown keys', () => {
    expect(() => parseConstitution('mode: strict\n', 'c.yml')).toThrow('unknown key(s) mode')
  })

  it('rejects mistyped values', () => {
    expect(() => parseConstitution('instructions: [a]\n', 'c.yml')).toThrow('"instructions" must be a string')
    expect(() => parseConstitution('writeHolds: "x"\n', 'c.yml')).toThrow('"writeHolds" must be an array')
    expect(() => parseConstitution('writeHolds: [""]\n', 'c.yml')).toThrow('"writeHolds" must be an array')
  })
})

describe('relWorkspacePath', () => {
  it('relativizes inside paths with POSIX separators', () => {
    expect(relWorkspacePath('/ws', '/ws/src/a.ts')).toBe('src/a.ts')
    expect(relWorkspacePath('/ws', '/ws/root.txt')).toBe('root.txt')
  })

  it('returns undefined for the root itself and outside paths', () => {
    expect(relWorkspacePath('/ws', '/ws')).toBeUndefined()
    expect(relWorkspacePath('/ws', '/ws-other/a.ts')).toBeUndefined()
    expect(relWorkspacePath('/ws', '/outside/a.ts')).toBeUndefined()
  })
})

describe('heldPattern', () => {
  it('matches exact files and recursive globs', () => {
    expect(heldPattern('package-lock.json', ['package-lock.json'])).toBe('package-lock.json')
    expect(heldPattern('src/secrets/key.yml', ['**/secrets/**'])).toBe('**/secrets/**')
  })

  it('matches dotfiles when the pattern is explicit', () => {
    expect(heldPattern('.env', ['.env'])).toBe('.env')
  })

  it('returns undefined when nothing matches', () => {
    expect(heldPattern('src/app.ts', ['**/secrets/**', 'package-lock.json'])).toBeUndefined()
  })
})
