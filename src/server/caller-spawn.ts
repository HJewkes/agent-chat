import os from 'node:os'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, RemoteLaunch, ServerMessage } from '../protocol.js'
import { defaultSpawnHost, placeRemoteSpawn, prepareRemoteSpawn, type SpawnHost } from './remote-launch.js'

/**
 * CC-1059: the requester's half of a spawn the broker recorded but cannot launch, because the
 * requester runs on another host. Both the `agent_spawn` tool and `agent-chat agent spawn` run it:
 * check and write on this host, report ready, open the surface only on the broker's ack, then
 * report placed and return the broker's final verdict in place of the pending `spawn_result`.
 */

type Broker = Pick<BrokerClient, 'request'>
type SpawnResult = Extract<ServerMessage, { t: 'spawn_result' }>
type LaunchedAck = Extract<ServerMessage, { t: 'spawn_launched_result' }>
type PlacedResult = Extract<ServerMessage, { t: 'spawn_placed_result' }>

/** What this process sends so the broker may hand it the launch: never model-supplied. */
export const launchHereFields = () => ({
  launchesHere: true as const,
  hostPlatform: process.platform,
  callerHome: os.homedir(),
})

/** Sends the spawn and, when the broker answers with a launch, runs it here before answering. */
export async function requestSpawn(
  broker: Broker,
  frame: Extract<ClientMessage, { t: 'spawn' }>,
  host: SpawnHost = defaultSpawnHost(),
): Promise<SpawnResult> {
  const res = (await broker.request(frame, 'spawn_result')) as SpawnResult
  if (!res.ok || res.launch === undefined) return res
  return runCallerSpawn(broker, res, res.launch, host)
}

async function reportLaunched(broker: Broker, agentId: string, ok: boolean, reason?: string) {
  try {
    return (await broker.request(
      { t: 'spawn_launched', agentId, ok, ...(reason === undefined ? {} : { reason }) },
      'spawn_launched_result',
    )) as LaunchedAck
  } catch (err) {
    return { t: 'spawn_launched_result', ok: false, reason: (err as Error).message } satisfies LaunchedAck
  }
}

/** The broker's verdict on the placement; a lost one is not a placement anybody confirmed. */
async function reportPlaced(broker: Broker, agentId: string, failure: string | undefined) {
  const report = failure === undefined ? { ok: true } : { ok: false, reason: failure }
  try {
    return (await broker.request(
      { t: 'spawn_placed', agentId, ...report },
      'spawn_placed_result',
    )) as PlacedResult
  } catch (err) {
    const reason =
      `placement unconfirmed: ${(err as Error).message}; check agent_list for ${agentId} ` +
      'before spawning again'
    return { t: 'spawn_placed_result', ok: false, agentId, reason } satisfies PlacedResult
  }
}

const refused = (res: SpawnResult, reason: string): SpawnResult => ({
  t: 'spawn_result',
  ok: false,
  ...(res.agentId === undefined ? {} : { agentId: res.agentId }),
  ...(res.name === undefined ? {} : { name: res.name }),
  reason,
})

async function runCallerSpawn(
  broker: Broker,
  res: SpawnResult,
  spec: RemoteLaunch,
  host: SpawnHost,
): Promise<SpawnResult> {
  const where = os.hostname()
  const prepared = prepareRemoteSpawn(spec, host)
  if (!prepared.ok) {
    await reportLaunched(broker, spec.agentId, false, prepared.reason)
    return refused(res, `refused on ${where}: ${prepared.reason}`)
  }
  const ack = await reportLaunched(broker, spec.agentId, true)
  if (!ack.ok) {
    host.discard(spec.agentId)
    return refused(res, `the broker did not accept the launch on ${where}: ${ack.reason ?? 'no reason'}`)
  }
  const failure = await placeRemoteSpawn(spec, prepared.plan, host)
  if (failure !== undefined) host.discard(spec.agentId)
  const placed = await reportPlaced(broker, spec.agentId, failure)
  return finalResult(res, placed, prepared.warnings, where)
}

/** The pending result's spawn-time facts, overlaid with the placement verdict. */
function finalResult(res: SpawnResult, placed: PlacedResult, warnings: string[], where: string): SpawnResult {
  const { launch: _launch, warnings: pending = [], ...facts } = res
  const { t: _t, warnings: late = [], ...verdict } = placed
  const all = [...pending, ...warnings, ...late]
  return { ...facts, ...verdict, host: res.host ?? where, ...(all.length === 0 ? {} : { warnings: all }) }
}
