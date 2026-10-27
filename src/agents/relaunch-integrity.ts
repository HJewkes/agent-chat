import fs from 'node:fs'
import net from 'node:net'
import { BrokerClient } from '../client/broker-client.js'
import { agentDir, socketPath } from '../paths.js'
import type { ServerMessage } from '../protocol.js'

/**
 * TP-4256 A3: `run-agent` starts claude from the launch files on disk, and those may be the very
 * files that changed (a plan.json without `--settings` starts a hookless agent). So it asks the
 * ledger's verdict first and fails closed: a broker it cannot reach, an agent the ledger does not
 * know, and a quarantine on the agent or any ancestor all refuse. Only a resume the human starts
 * writes the files again under a fresh admission.
 */

type RelaunchResult = Extract<ServerMessage, { t: 'integrity_relaunch_result' }>
export type AskRelaunch = (agentId: string) => Promise<RelaunchResult>

/** The exit `run-agent` gives for a launch the ledger would not let start. */
export const RELAUNCH_REFUSED_EXIT = 77

/** One attempt, not the client's reconnect ladder or its auto-start: a refusal is the answer either way. */
const probeBroker = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath())
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', () => reject(new Error('no broker is listening')))
  })

/** The realpath, so a symlink into the broker's agents root is judged by where it leads. */
const launchDir = (agentId: string): string => {
  const dir = agentDir(agentId)
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

export const askBroker: AskRelaunch = async agentId => {
  await probeBroker()
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return (await client.request(
      { t: 'integrity_relaunch', agentId, agentDir: launchDir(agentId) },
      'integrity_relaunch_result',
    )) as RelaunchResult
  } finally {
    client.close()
  }
}

/** Why the launch must not start, or undefined to start it. Every failure refuses. */
export async function relaunchRefusal(
  agentId: string,
  ask: AskRelaunch = askBroker,
): Promise<string | undefined> {
  let result: RelaunchResult
  try {
    result = await ask(agentId)
  } catch (err) {
    return refusal(`the broker could not be asked (${(err as Error).message})`)
  }
  if (result.ok) return undefined
  if (result.file === undefined) return refusal(`the ledger refused it: ${result.reason}`)
  return refusal(`it is ${result.reason}: ${result.file} changed (${result.field ?? 'unknown'})`)
}

const refusal = (why: string): string =>
  `agent-chat run-agent: not launched, ${why}. Nothing launches from these files; ` +
  'a resume the human starts (`agent-chat agent resume`) writes them again under a fresh baseline'
