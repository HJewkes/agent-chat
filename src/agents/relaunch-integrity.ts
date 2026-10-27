import net from 'node:net'
import { BrokerClient } from '../client/broker-client.js'
import type { Mismatch } from '../leak-guard/integrity/record.js'
import { socketPath } from '../paths.js'
import type { ServerMessage } from '../protocol.js'

/**
 * TP-4256 A3: `run-agent` starts claude from the launch files on disk, and a quarantined launch's
 * files may be the very ones that changed (a plan.json without `--settings` starts a hookless
 * agent). So it asks the broker first, and a quarantined launch is not started again.
 *
 * A broker it cannot reach lets the launch go on, with a line on stderr: the broker that comes up
 * next holds no baseline for this agent, so refusing here would protect nothing.
 */

type RelaunchResult = Extract<ServerMessage, { t: 'integrity_relaunch_result' }>
export type AskRelaunch = (agentId: string) => Promise<RelaunchResult>

/**
 * One attempt, not the client's 8.85 s reconnect ladder: a broker that comes up mid-ladder holds no
 * baseline either, so waiting for it would only delay every launch made while none is running.
 */
const probeBroker = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath())
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', () => reject(new Error('no broker is listening')))
  })

const askBroker: AskRelaunch = async agentId => {
  await probeBroker()
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return (await client.request(
      { t: 'integrity_relaunch', agentId },
      'integrity_relaunch_result',
    )) as RelaunchResult
  } finally {
    client.close()
  }
}

/** Why the launch must not start, or undefined to start it. */
export async function relaunchRefusal(
  agentId: string,
  ask: AskRelaunch = askBroker,
  warn: (line: string) => void = line => void process.stderr.write(line),
): Promise<string | undefined> {
  let result: RelaunchResult
  try {
    result = await ask(agentId)
  } catch (err) {
    warn(`agent-chat run-agent: integrity relaunch check skipped: ${(err as Error).message}\n`)
    return undefined
  }
  if (result.ok) return undefined
  return `agent-chat run-agent: ${quarantinedLaunch(result)}.`
}

/** One wording for every place a quarantined launch is refused, broker-side or in run-agent. */
export const quarantinedLaunch = (mismatch: Mismatch): string =>
  `this launch is quarantined: ${mismatch.file} changed (${mismatch.field}). ` +
  'Neither it nor a launch it starts runs; only a resume the human starts (`agent-chat agent resume`) ' +
  'writes new files under a fresh baseline'
