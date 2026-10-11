import { describe, expect, it } from 'vitest'
import {
  HUMAN_OPS,
  OPS,
  type Op,
  declaredOps,
  doneWhenHash,
  isHumanStep,
  opsHits,
  opsLint,
  opsNoneTag,
} from '../agents/burndown/ops.js'

const FIXTURES: Record<Op, string> = {
  deploy: 'the service deploys the build',
  restart: 'live after a broker restart',
  'config-edit': 'add the flag to settings.json',
  publish: 'run npm publish for the package',
  spend: 'purchase a larger plan',
  'force-push': 'force-push the branch',
  'ruleset-write': 'turn on branch protection for main',
}

const FILENAME = 'deploy-ports.ts isAlive is deleted'

describe('burndown ops vocabulary (CC-974)', () => {
  it.each(OPS)('spots the op %s in a done_when that names it', op => {
    expect(opsHits(FIXTURES[op]).map(hit => hit.op)).toContain(op)
  })

  it('keeps publish out of the human ops, as a grant unlocks it', () => {
    expect(HUMAN_OPS).not.toContain('publish')
    expect(HUMAN_OPS).toHaveLength(OPS.length - 1)
  })

  it('reports a filename hit with the op and the matched text', () => {
    expect(opsLint(FILENAME, [])).toEqual([{ op: 'deploy', text: 'deploy' }])
  })

  it('resolves every hit with ops:none for the current text', () => {
    expect(opsLint(FILENAME, [opsNoneTag(FILENAME)])).toEqual([])
  })

  it('keeps the ops:none tag valid when only the whitespace changes', () => {
    const reflowed = `  deploy-ports.ts\n   isAlive  is deleted `

    expect(opsLint(reflowed, [opsNoneTag(FILENAME)])).toEqual([])
  })

  it('brings the hit back when the done_when is edited under the same tag', () => {
    const edited = `${FILENAME}; deploy the merged sha`

    expect(opsLint(edited, [opsNoneTag(FILENAME)]).map(hit => hit.op)).toEqual(['deploy'])
  })

  it('resolves a deploy hit with a declared ops:deploy and leaves other ops unresolved', () => {
    const doneWhen = 'deploy the build, then restart the broker'

    expect(opsLint(doneWhen, ['ops:deploy'])).toEqual([{ op: 'restart', text: 'restart the broker' }])
  })

  it('makes the ops:none tag 8 hex digits', () => {
    expect(doneWhenHash(FILENAME)).toMatch(/^[0-9a-f]{8}$/)
    expect(opsNoneTag(FILENAME)).toBe(`ops:none=${doneWhenHash(FILENAME)}`)
  })

  it('reads declared ops from tags, skipping ops:none and unknown ops', () => {
    expect(declaredOps(['ops:deploy', 'ops:none=abcd1234', 'ops:teleport', 'kind:bug'])).toEqual(['deploy'])
  })

  it.each(['kind:operator', 'kind:owner'])('calls a %s task a human step', tag => {
    expect(isHumanStep([tag, 'p:1'])).toBe(true)
  })

  it('does not call a code task a human step', () => {
    expect(isHumanStep(['kind:bug', 'ops:deploy'])).toBe(false)
  })
})
