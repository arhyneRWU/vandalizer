import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SUPPORTED_EXTENSIONS, SUPPORTED_ACCEPT_ATTR, isSupportedExtension } from './fileTypes'

/**
 * The upload list and the automation file-type filter drifted apart once
 * already: the filter offered `html` (which no upload can produce, so the
 * automation could never fire) and omitted `md` (which uploads fine).
 * Pin the frontend list to the server's, which is the only real gate.
 */
function backendAllowedExts(): string[] {
  const src = readFileSync(
    resolve(__dirname, '../../../backend/app/utils/file_validation.py'),
    'utf-8',
  )
  const match = src.match(/ALLOWED_EXTS\s*=\s*\{([^}]*)\}/)
  if (!match) throw new Error('ALLOWED_EXTS not found in file_validation.py')
  return match[1]
    .split(',')
    .map(part => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .sort()
}

describe('supported file types', () => {
  it('matches the extensions the backend accepts', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(backendAllowedExts())
  })

  it('offers md and does not offer html', () => {
    expect(SUPPORTED_EXTENSIONS).toContain('md')
    expect(SUPPORTED_EXTENSIONS).not.toContain('html')
  })

  it('builds an accept attribute of dotted extensions', () => {
    expect(SUPPORTED_ACCEPT_ATTR.split(',')).toEqual(
      SUPPORTED_EXTENSIONS.map(e => `.${e}`),
    )
  })

  it('normalizes case and a leading dot', () => {
    expect(isSupportedExtension('.PDF')).toBe(true)
    expect(isSupportedExtension('html')).toBe(false)
  })
})
