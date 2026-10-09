import { readLaunchPlan } from '../agents/launch-files.js'
import { surfaceFor } from '../agents/launcher.js'
import { PANE_EXIT_TIMEOUT_MS, PANE_SETTLE_MS } from '../agents/teleport.js'
import type { LaunchPlan } from '../agents/types.js'
import { withBroker } from '../cli/client.js'
import { SURFACE_NAMES, type SurfaceName } from '../protocol.js'
import { reportUnplaced } from './caller-teleport.js'

/**
 * CC-913: the detached half of a teleport from another host. The caller's MCP process dies with
 * its Claude Code, and a command typed into a pane that Claude Code still holds is swallowed
 * (CC-402), so this process outlives both: it is armed before the broker accepts the report,
 * released only after, waits for the predecessor's pid to exit, then types the successor into
 * the freed pane. Its one retry is today's placement beside the anchor.
 */

export interface Placement {
  anchor?: string
  reuseAnchor?: boolean
}

export interface LandInput {
  surface: SurfaceName
  plan: LaunchPlan
  hostPid: number
  anchor?: string
}

export interface LandDeps {
  pidAlive(pid: number): boolean
  now(): number
  sleep(ms: number): Promise<void>
  launch(surface: SurfaceName, plan: LaunchPlan, placement: Placement): Promise<void>
  /** Nobody is left in the session to notice, so a successor that never started goes to the broker. */
  failed(reason: string): Promise<void>
}

const PANE_EXIT_POLL_MS = 100

/** The pane is free once the pid is gone and its shell has had a beat to reach a prompt. */
async function waitForExit(pid: number, deps: LandDeps): Promise<boolean> {
  const deadline = deps.now() + PANE_EXIT_TIMEOUT_MS
  while (deps.pidAlive(pid)) {
    if (deps.now() >= deadline) return false
    await deps.sleep(PANE_EXIT_POLL_MS)
  }
  await deps.sleep(PANE_SETTLE_MS)
  return true
}

async function attempt(input: LandInput, deps: LandDeps, placement: Placement): Promise<string | undefined> {
  try {
    await deps.launch(input.surface, input.plan, placement)
    return undefined
  } catch (err) {
    return (err as Error).message
  }
}

/** Into the predecessor's pane when it frees, else beside the anchor; the broker hears only when both fail. */
export async function landSuccessor(input: LandInput, deps: LandDeps): Promise<void> {
  const { anchor } = input
  const beside: Placement = anchor === undefined ? {} : { anchor }
  const paneFree = await waitForExit(input.hostPid, deps)
  const reasons: string[] = []
  if (paneFree && anchor !== undefined) {
    const inPane = await attempt(input, deps, { anchor, reuseAnchor: true })
    if (inPane === undefined) return
    reasons.push(`in its pane: ${inPane}`)
  } else if (!paneFree)
    reasons.push(`pid ${input.hostPid} still held its pane after ${PANE_EXIT_TIMEOUT_MS / 1000}s`)
  const besideAnchor = await attempt(input, deps, beside)
  if (besideAnchor === undefined) return
  reasons.push(`beside it: ${besideAnchor}`)
  await deps.failed(reasons.join('; '))
}

const GO = /^go(?: (\S+))?$/

/** The landing token on the caller's "go" line ('' when the broker sent none); undefined when stdin closes first. */
export function waitForGo(stdin: NodeJS.ReadableStream): Promise<string | undefined> {
  return new Promise(resolve => {
    let seen = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk: string) => {
      seen += chunk
      const go = seen
        .split('\n')
        .slice(0, -1)
        .map(line => GO.exec(line))
        .find(match => match !== null)
      if (go) resolve(go[1] ?? '')
    })
    stdin.on('end', () => resolve(undefined))
    stdin.on('error', () => resolve(undefined))
  })
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const defaultLandDeps = (agentId: string, token: string): LandDeps => ({
  pidAlive,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  launch: async (surface, plan, placement) => void (await surfaceFor(surface, placement).launch(plan)),
  failed: async reason => {
    const answer = await withBroker(broker => reportUnplaced(broker, agentId, token, reason))
    if (!answer.ok)
      process.stderr.write(`teleport-land: broker refused the failure report: ${answer.reason}\n`)
  },
})

export interface LandOptions {
  pid: string
  surface: string
  anchor?: string
}

const AGENT_ID = /^[0-9a-f]{8}$/

function checkLandArgs(agentId: string, options: LandOptions): number {
  const hostPid = Number.parseInt(options.pid, 10)
  if (!AGENT_ID.test(agentId) || !Number.isInteger(hostPid) || hostPid <= 1)
    throw new Error(`teleport-land: bad agent id or pid (${agentId}, ${options.pid})`)
  if (!(SURFACE_NAMES as readonly string[]).includes(options.surface))
    throw new Error(`teleport-land: unknown surface ${options.surface}`)
  return hostPid
}

/** `agent-chat teleport-land`: spawned by the caller's MCP process, never by a person. */
export async function runLandVerb(agentId: string, options: LandOptions): Promise<void> {
  const hostPid = checkLandArgs(agentId, options)
  const token = await waitForGo(process.stdin)
  if (token === undefined) return
  process.stdin.destroy()
  const deps = defaultLandDeps(agentId, token)
  let plan: LaunchPlan
  try {
    plan = readLaunchPlan(agentId)
  } catch (err) {
    return deps.failed((err as Error).message)
  }
  const anchor = options.anchor === undefined ? {} : { anchor: options.anchor }
  await landSuccessor({ surface: options.surface as SurfaceName, plan, hostPid, ...anchor }, deps)
}
