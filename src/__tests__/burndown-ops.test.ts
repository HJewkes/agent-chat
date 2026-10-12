import { HARD_STOP_CLASSES } from '@titan-design/coordinator'
import { describe, expect, it } from 'vitest'
import {
  HARD_STOP_OPS,
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
import { stopShortNames } from '../agents/burndown/score.js'

const FIXTURES: Record<Op, string> = {
  deploy: 'the service deploys the build',
  restart: 'live after a broker restart',
  'config-edit': 'add the flag to settings.json',
  publish: 'run npm publish for the package',
  spend: 'purchase a larger plan',
  'force-push': 'force-push the branch',
  'ruleset-write': 'turn on branch protection for main',
  'dotfiles-merge': 'merge the dotfiles PR',
  message: 'email the vendor about the invoice',
  'personal-data': 'read the lab results',
}

const FILENAME = 'deploy-ports.ts isAlive is deleted'

describe('burndown ops vocabulary (CC-974)', () => {
  it.each(OPS)('spots the op %s in a done_when that names it', op => {
    expect(opsHits(FIXTURES[op]).map(hit => hit.op)).toContain(op)
  })

  it.each(HARD_STOP_CLASSES)('maps the hard-stop class %s to an op', name => {
    expect(OPS).toContain(HARD_STOP_OPS[name])
  })

  it.each([
    ['merge the dotfiles PR', 'dotfiles-merge'],
    ['email the vendor', 'message'],
    ['read the lab results', 'personal-data'],
  ])('flags "%s" as the human op %s', (doneWhen, op) => {
    expect(opsLint(doneWhen, []).map(hit => hit.op)).toEqual([op])
  })

  it.each([
    ['the service deploys the build', ['deploy']],
    ['launchd install of the tick', ['deploy']],
    ['live after a broker restart', ['restart']],
    ['add the flag to settings.json', ['config-edit']],
    ['run npm publish for the package', ['publish']],
    ['cut a release tag', ['publish']],
    ['publishes the docs site', ['publish']],
    ['submit the order', ['spend']],
    ['purchase a larger plan', ['spend']],
    ['git reset --hard origin/main', ['force-push']],
    ['update the ruleset', ['ruleset-write']],
  ])('keeps the ops a pre-existing pattern found in "%s"', (doneWhen, ops) => {
    expect([...new Set(opsHits(doneWhen).map(hit => hit.op))]).toEqual(ops)
  })

  it('stops a task declaring ops:message short at third-party-message', () => {
    const hardStops = new Set(['third-party-message', 'deploy'])

    expect(opsLint('contact the landlord about the lease', ['ops:message'])).toEqual([])
    expect(stopShortNames(['ops:message'], hardStops)).toEqual(['third-party-message'])
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
