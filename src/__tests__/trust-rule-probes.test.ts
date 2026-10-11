import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Found {
  label: string
  at: number
  code: string | null
}
const probesModule = (await import(
  pathToFileURL(path.join(process.cwd(), 'scripts/trust-rule-probes.mjs')).href
)) as { extractProbes: (bundle: string) => Found[] }

const fixture = (version: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures/trust-rule', `${version}.js.txt`), 'latin1')

describe('trust rule probes', () => {
  it.each(['2.1.292', '2.1.295'])('find all four trust-rule snippets in the %s fixture', v => {
    const found = probesModule.extractProbes(fixture(v))
    expect(found).toHaveLength(4)
    expect(found.filter(f => f.at < 0).map(f => f.label)).toEqual([])
  })

  it('does not match a bundle without the trust check', () => {
    const found = probesModule.extractProbes('function a(){return 1}')
    expect(found.every(f => f.at < 0)).toBe(true)
  })

  it('reads the flag as hasTrustDialogAccepted in the 2.1.295 trust check', () => {
    const [trust] = probesModule.extractProbes(fixture('2.1.295'))
    expect(trust?.code).toContain('.projects?.[n]?.hasTrustDialogAccepted')
  })
})
