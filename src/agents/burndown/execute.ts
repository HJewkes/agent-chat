import { logFindings } from './finding.js'
import { applyActions, claimKey, type Action, type ClaimKey } from './advance.js'
import { sameClaim, writeLedger, type Claim, type Ledger } from './ledger.js'
import { targetRef, type RegisterReply, type Registration } from './shepherd.js'

type Unretired = NonNullable<Claim['unretired']>[number]

/**
 * Carries out a tick's steps against the ledger and the broker, intent first:
 * every spawn's claim is on disk in `spawning`, and the intent is logged,
 * before the frame goes out. A crash between the two leaves a claim the next
 * tick reconciles by name (or stalls after ten minutes), never an agent the
 * ledger does not know about.
 */

/** The only spawn shape the tick sends: headless, on an account named explicitly, tagged as burndown's. */
export interface SpawnFrame {
  t: 'spawn'
  name: string
  profile: string
  brief: string
  cwd: string
  /** Always set: an unset one falls through to the initiative profile or the broker's own account. */
  configDir: string
  surface: 'headless'
  briefing: string
  tags: string[]
  predecessor?: string
  worktree?: string
}

export interface SpawnSpec {
  name: string
  profile: string
  brief: string
  cwd: string
  configDir: string
  initiative: string
  taskId: string
  predecessor?: string
  worktree?: string
}

export function spawnFrame(s: SpawnSpec): SpawnFrame {
  return {
    t: 'spawn',
    name: s.name,
    profile: s.profile,
    brief: s.brief,
    cwd: s.cwd,
    configDir: s.configDir,
    surface: 'headless',
    briefing: s.initiative,
    tags: ['burndown', `task:${s.taskId}`],
    ...(s.predecessor === undefined ? {} : { predecessor: s.predecessor }),
    ...(s.worktree === undefined ? {} : { worktree: s.worktree }),
  }
}

export type Step =
  | { kind: 'ledger'; actions: Action[] }
  | { kind: 'spawn'; key: ClaimKey; frame: SpawnFrame }
  | { kind: 'retire'; key: ClaimKey; names: string[] }
  | { kind: 'register'; key: ClaimKey; registration: Registration }

export interface SpawnReply {
  ok: boolean
  agentId?: string
  reason?: string
}

export interface ExecuteDeps {
  ledgerFile: string
  spawn: (frame: SpawnFrame) => Promise<SpawnReply>
  retire: (name: string) => Promise<SpawnReply>
  register: (registration: Registration) => RegisterReply
  log: (event: string, detail: Record<string, unknown>) => void
  now: Date
}

export interface Executed {
  ledger: Ledger
  lines: string[]
}

export async function execute(steps: Step[], start: Ledger, deps: ExecuteDeps): Promise<Executed> {
  let ledger = start
  const lines: string[] = []
  const commit = (actions: Action[]): void => {
    const before = ledger
    ledger = applyActions(ledger, actions, deps.now)
    logFindings(before, ledger, deps.log)
    writeLedger(deps.ledgerFile, ledger)
  }
  for (const step of steps) {
    if (step.kind === 'ledger') commit(step.actions)
    else if (step.kind === 'retire') {
      const retired = await retireAll(step, deps)
      ledger = withUnretired(ledger, step.key, retired.left)
      writeLedger(deps.ledgerFile, ledger)
      lines.push(...retired.lines)
    } else if (step.kind === 'register') lines.push(registerOne(step, commit, deps))
    else lines.push(await spawnOne(step, ledger, commit, deps))
  }
  return { ledger, lines }
}

/** The claim was marked done before its retire ran, so the refusals go on the newest done claim with that key. */
export function withUnretired(ledger: Ledger, key: ClaimKey, left: Unretired[]): Ledger {
  const index = ledger.claims.findLastIndex(c => c.phase === 'done' && sameClaim(c, key))
  if (index === -1) return ledger
  const { unretired: _previous, ...claim } = ledger.claims[index] as Claim
  const claims = [...ledger.claims]
  claims[index] = left.length === 0 ? claim : { ...claim, unretired: left }
  return { ...ledger, claims }
}

/** A spawn whose claim is not already recorded in `spawning` under this name is refused, whatever built the steps. */
function intentRecorded(ledger: Ledger, key: ClaimKey, name: string): boolean {
  return ledger.claims.some(c => c.phase === 'spawning' && c.agentName === name && sameClaim(c, key))
}

async function spawnOne(
  step: Extract<Step, { kind: 'spawn' }>,
  ledger: Ledger,
  commit: (actions: Action[]) => void,
  deps: ExecuteDeps,
): Promise<string> {
  const { frame, key } = step
  const { brief, ...shown } = frame
  if (!intentRecorded(ledger, key, frame.name))
    return `not spawned ${frame.name}: no spawning claim recorded for ${claimKey(key)}`
  deps.log('burndown_spawn_intent', { ...shown, briefChars: brief.length })
  let reply: SpawnReply
  try {
    reply = await deps.spawn(frame)
  } catch (err) {
    // The frame may have landed; the claim stays `spawning` and the next tick finds the row by name.
    return `spawn ${frame.name} unanswered (${(err as Error).message}); left spawning for the next tick`
  }
  deps.log('burndown_spawn_result', { name: frame.name, ok: reply.ok, reason: reply.reason })
  if (reply.ok) {
    commit([{ kind: 'update', key, patch: { agentId: reply.agentId } }])
    return `spawned ${frame.name} (${reply.agentId ?? '?'}) as ${frame.profile} on ${frame.configDir}`
  }
  const stalledReason = refusalReason(frame, reply.reason ?? 'refused without a reason')
  commit([{ kind: 'update', key, patch: { stalledReason, stalledClass: 'failed' } }])
  return `not spawned ${frame.name}: ${stalledReason}`
}

/** A refused registration stalls the claim, since burndown never merges; an unanswered one is retried next tick. */
function registerOne(
  step: Extract<Step, { kind: 'register' }>,
  commit: (actions: Action[]) => void,
  deps: ExecuteDeps,
): string {
  const ref = targetRef(step.registration.target)
  const reply = deps.register(step.registration)
  deps.log('burndown_shepherd_register', { pr: ref, task: step.registration.task, ...reply })
  if (reply.ok) return `registered ${ref} with Shepherd for ${claimKey(step.key)}`
  if (!reply.refused) return `register ${ref} with Shepherd failed (${reply.reason}); retried next tick`
  const stalledReason = `Shepherd refused ${ref} (${reply.reason}); burndown does not merge, so the PR is left for the owner`
  commit([{ kind: 'update', key: step.key, patch: { stalledReason, stalledClass: 'gate-trip' } }])
  return `not registered ${ref}: ${stalledReason}`
}

/** A refusal after allocation leaves the worktree behind (the supervisor releases the slot only), so name it. */
export function refusalReason(frame: SpawnFrame, reason: string): string {
  if (!reason.startsWith('spawn failed:')) return `spawn refused: ${reason}`
  const leftover = frame.worktree === undefined ? `${frame.cwd}/.worktrees/${frame.name}` : undefined
  return leftover === undefined
    ? `spawn refused: ${reason}`
    : `spawn refused: ${reason}; the worktree ${leftover} may be left behind, reclaim it by hand`
}

async function retireAll(
  step: Extract<Step, { kind: 'retire' }>,
  deps: ExecuteDeps,
): Promise<{ lines: string[]; left: Unretired[] }> {
  const lines: string[] = []
  const left: Unretired[] = []
  for (const name of step.names) {
    const reply = await deps.retire(name).catch((err: Error) => ({ ok: false, reason: err.message }))
    deps.log('burndown_retire', { name, ok: reply.ok, reason: reply.reason })
    if (reply.ok) lines.push(`retired ${name}`)
    else {
      left.push({ name, reason: reply.reason ?? 'refused', at: deps.now.toISOString() })
      lines.push(
        `left ${name}: ${reply.reason ?? 'refused'}; recorded on ${claimKey(step.key)}, retried next tick`,
      )
    }
  }
  return { lines, left }
}
