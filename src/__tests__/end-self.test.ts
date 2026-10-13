import { describe, expect, it, vi } from 'vitest'
import { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'
import { endSelfHandler } from '../server/end-self.js'

/** CC-1059 d: retire of an agent on another host reaches it as `end_self` on its own connection. */

const handlerWith = (ownAgentId: string | undefined, hostPid: number | undefined) => {
  const end = vi.fn(() => ({ ok: true }))
  const log = vi.fn()
  return { end, log, onEndSelf: endSelfHandler({ ownAgentId, hostPid, end, log }) }
}

describe('an end_self push reaching an MCP process', () => {
  it('ends its own Claude Code when the frame names its own agent id', () => {
    const { end, onEndSelf } = handlerWith('agent-1', 777)

    onEndSelf('agent-1', 'retired')

    expect(end).toHaveBeenCalledWith('this agent', 777)
  })

  it('is ignored and logged when the frame names another agent', () => {
    const { end, log, onEndSelf } = handlerWith('agent-1', 777)

    onEndSelf('agent-2', 'retired')

    expect(end).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('end_self_ignored', expect.objectContaining({ agentId: 'agent-2' }))
  })

  it('ends nothing in an ordinary session, which has no spawn identity', () => {
    const { end, onEndSelf } = handlerWith(undefined, 777)

    onEndSelf('agent-1', 'retired')

    expect(end).not.toHaveBeenCalled()
  })

  it('is handed from the broker client to its onEndSelf option', () => {
    const onEndSelf = vi.fn()
    const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
      autoStart: false,
      onEndSelf,
    })
    const frame: ServerMessage = { t: 'end_self', agentId: 'agent-1', reason: 'retired' }

    ;(client as unknown as { handle: (msg: ServerMessage) => void }).handle(frame)

    expect(onEndSelf).toHaveBeenCalledWith('agent-1', 'retired')
  })
})
