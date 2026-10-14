import { describe, expect, it } from 'vitest'
import { isProtectedPath } from '../agents/burndown/pr-adopt.js'
import { outsideOwns } from '../agents/burndown/owns-fence.js'

/** A slice's changed files against its declared owns (CC-669): pure, no git. */

const OWNS = ['src/agents/burndown/collision.ts']

describe('a slice PR against its owns', () => {
  it('reports nothing for a file the slice owns', () => {
    expect(outsideOwns(['src/agents/burndown/collision.ts'], OWNS)).toEqual([])
  })

  it('allows a companion test in src/__tests__ named for the owned file', () => {
    expect(outsideOwns(['src/__tests__/burndown-collision.test.ts'], OWNS)).toEqual([])
  })

  it('allows a test beside the owned file', () => {
    expect(outsideOwns(['src/agents/burndown/collision.test.ts'], OWNS)).toEqual([])
  })

  it('reports a file outside the owns', () => {
    const files = ['src/agents/burndown/collision.ts', 'src/agents/burndown/ledger.ts']

    expect(outsideOwns(files, OWNS)).toEqual(['src/agents/burndown/ledger.ts'])
  })

  it('reports a test that names no owned stem', () => {
    expect(outsideOwns(['src/__tests__/burndown-ledger.test.ts'], OWNS)).toEqual([
      'src/__tests__/burndown-ledger.test.ts',
    ])
  })

  describe('a companion carries a dir segment of its owned file before the name (CC-832)', () => {
    it('reports a test whose name only ends with the owned stem', () => {
      expect(outsideOwns(['src/__tests__/launch-plan.test.ts'], ['src/agents/burndown/plan.ts'])).toEqual([
        'src/__tests__/launch-plan.test.ts',
      ])
      expect(outsideOwns(['src/__tests__/exit-report.test.ts'], ['src/agents/burndown/report.ts'])).toEqual([
        'src/__tests__/exit-report.test.ts',
      ])
    })

    it('reports a test whose prefix is not a dir segment of the owned file', () => {
      expect(
        outsideOwns(['src/__tests__/mirror-launchd.test.ts'], ['src/agents/burndown/launchd.ts']),
      ).toEqual(['src/__tests__/mirror-launchd.test.ts'])
    })

    it('allows a test with words between the dir segment and the owned stem', () => {
      expect(
        outsideOwns(['src/__tests__/burndown-claim-advance.test.ts'], ['src/agents/burndown/advance.ts']),
      ).toEqual([])
    })

    it('allows a test named for a hyphenated owned stem under its dir segment', () => {
      expect(
        outsideOwns(['src/__tests__/burndown-owns-fence.test.ts'], ['src/agents/burndown/owns-fence.ts']),
      ).toEqual([])
    })
  })

  it("allows a test named for a wildcard entry's dir, and reports one named for another", () => {
    const files = ['src/__tests__/burndown-owns-fence.test.ts', 'src/__tests__/seats-owns.test.ts']

    expect(outsideOwns(files, ['src/agents/burndown/*.ts'])).toEqual(['src/__tests__/seats-owns.test.ts'])
  })

  it('does not stall a slice for the changeset and capabilities boilerplate it never declared', () => {
    const files = ['src/foo/a.ts', '.changeset/x.md', 'CAPABILITIES.md']

    expect(outsideOwns(files, ['src/foo/**'])).toEqual([])
  })

  it('still names a real source file the slice does not own beside the boilerplate', () => {
    const files = ['src/foo/a.ts', '.changeset/x.md', 'CAPABILITIES.md', 'src/bar/b.ts']

    expect(outsideOwns(files, ['src/foo/**'])).toEqual(['src/bar/b.ts'])
  })

  it('allows nested readmes, reference docs and goldens without owns', () => {
    const files = ['pkg/README.md', 'site/reference/cli.md', 'golden/cli-help.txt', 'audit/spawn-doors.json']

    expect(outsideOwns(files, [])).toEqual([])
  })

  it('keeps a file the implicit allowlist covers protected for PR adoption', () => {
    expect(outsideOwns(['audit/spawn-doors.json'], [])).toEqual([])
    expect(isProtectedPath('audit/spawn-doors.json')).toBe(true)
  })

  describe('generated api declarations and lockfiles (CC-1150 d)', () => {
    const SRC_OWNS = ['packages/code-graph/src/a.ts']

    it('allows a generated api d.ts and lockfiles without owns, at any depth and at the root', () => {
      const files = [
        'packages/code-graph/api/index.d.ts',
        'api/index.d.ts',
        'pnpm-lock.yaml',
        'packages/x/pnpm-lock.yaml',
        'package-lock.json',
        'packages/x/package-lock.json',
        'yarn.lock',
        'packages/x/yarn.lock',
      ]

      expect(outsideOwns(files, SRC_OWNS)).toEqual([])
    })

    it('still reports a source file under api/, a d.ts outside api/, and a nested api d.ts', () => {
      const files = [
        'packages/code-graph/api/index.ts',
        'packages/code-graph/src/types.d.ts',
        'packages/code-graph/api/nested/deep.d.ts',
        'packages/code-graph/api/index.d.ts.map',
      ]

      expect(outsideOwns(files, SRC_OWNS)).toEqual(files)
    })

    it('still reports a path that only looks like a lockfile', () => {
      const files = [
        'lockfile.json',
        'package-lock.json.bak',
        'my-package-lock.json',
        'src/pnpm-lock.yaml.ts',
        'notyarn.lock',
        'pnpm-lock.yml',
      ]

      expect(outsideOwns(files, SRC_OWNS)).toEqual(files)
    })

    it('keeps lockfiles and package manifests protected for PR adoption', () => {
      expect(outsideOwns(['package-lock.json'], [])).toEqual([])
      expect(isProtectedPath('package-lock.json')).toBe(true)
      expect(isProtectedPath('packages/x/package-lock.json')).toBe(true)
    })
  })
})
