import { describe, expect, it } from 'vitest'
import { describeInbox } from '../cli/human.js'
import { buildBatch } from '../inbox/batch.js'
import { renderBatch } from '../inbox/render.js'
import type { QueueItem, ServerMessage } from '../protocol.js'

/**
 * CC-169: a service ask is filed under a label nobody vouches for, and no
 * session waits on it live. Without a marker a label such as `owner` reads as
 * a real session in the human's inbox.
 */

const item = (msgId: string, from: string, meta: Record<string, string>): QueueItem => ({
  msgId,
  kind: 'question',
  from,
  text: 'Approve the gate?',
  at: Date.now(),
  meta,
})

const queue = (): Extract<ServerMessage, { t: 'queue_result' }> => ({
  t: 'queue_result',
  items: [item('svc-1', 'owner', { source: 'service' }), item('peer-1', 'worker-a', {})],
})

const headerOf = (lines: string[], msgId: string): string => lines.find(l => l.includes(msgId))!

describe('a service ask is marked wherever the human reads the queue', () => {
  // Mutation caught: `describeInbox` printing the label alone, so a service label passes for a session.
  it('marks the service question in the plain inbox and leaves a session question unmarked', () => {
    const { lines } = describeInbox(queue())

    expect(headerOf(lines, 'svc-1')).toContain('owner (service)')
    expect(headerOf(lines, 'peer-1')).not.toContain('(service)')
  })

  // Mutation caught: the batch header printing the label alone.
  it('marks the service question in the batch inbox and leaves a session question unmarked', () => {
    const lines = renderBatch(buildBatch(queue()), 'batch-1')

    expect(headerOf(lines, 'svc-1')).toContain('from owner (service)')
    expect(headerOf(lines, 'peer-1')).not.toContain('(service)')
  })
})
