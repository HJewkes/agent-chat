import { describe, expect, it } from 'vitest'
import { agentTmpSweepRoots } from '../agents/orphan-sweep.js'

describe('the roots the broker sweeps for agent TMPDIRs', () => {
  it('sweeps both /tmp and the home disk root', () => {
    expect(agentTmpSweepRoots('/home/example')).toEqual(['/tmp', '/home/example/.cache/agent-chat/tmp'])
  })
})
