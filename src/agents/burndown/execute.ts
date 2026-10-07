import { logFindings } from './finding.js'
import { applyActions, claimKey, type Action, type ClaimKey } from './advance.js'
import { sameClaim, writeLedger, type Claim, type Ledger } from './ledger.js'
import { clearLiveness, factFingerprint, LIVENESS_LIMIT, maskText, pruneLiveness, spend } from './liveness.js'
import { parkUpdate } from './stall-code.js'
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
  /** The tier the plan placed the task in (CC-774); the broker writes it on the `dispatched` row. */
  tier?: number
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
  tier?: number
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
    ...(s.tier === undefined ? {} : { tier: s.tier }),
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
  /** The broker's typed refusal, such as `machine_headless_limit`. */
  code?: string
  /** A refusal that clears by itself (a rate or capacity limit), so it spends no liveness budget. */
  retryable?: boolean
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
  let ledger = pruneLiveness(start, deps.now)
  const lines: string[] = []
  const save = (next: Ledger): void => {
    const before = ledger
    ledger = next
    writeLedger(deps.ledgerFile, ledger)
    logFindings(before, ledger, deps.log)
  }
  const commit = (actions: Action[]): void => save(applyActions(ledger, actions, deps.now))
  for (const step of steps) {
    if (step.kind === 'ledger') commit(step.actions)
    else if (step.kind === 'retire') {
      const retired = await retireAll(step, deps)
      ledger = withUnretired(ledger, step.key, retired.left)
      writeLedger(deps.ledgerFile, ledger)
      lines.push(...retired.lines)
    } else if (step.kind === 'register') lines.push(registerOne(step, { ledger, save }, deps))
    else lines.push(await spawnOne(step, { start, ledger, save }, deps))
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

/** The claim for `key` as it stood at tick start, or none when the tick added it (a fresh dispatch). */
export function undoIntent(ledger: Ledger, start: Ledger, key: ClaimKey): Ledger {
  const held = (claims: Claim[]): number => claims.findIndex(c => c.phase !== 'done' && sameClaim(c, key))
  const index = held(ledger.claims)
  if (index === -1) return ledger
  const was = start.claims[held(start.claims)]
  const claims =
    was === undefined ? ledger.claims.filter((_, i) => i !== index) : ledger.claims.with(index, was)
  return { ...ledger, claims }
}

/** The liveness action a spawn spends under: one budget per claim and profile. */
const spawnAction = (frame: SpawnFrame): string => `spawn:${frame.profile}`

interface SpawnState {
  start: Ledger
  ledger: Ledger
  save: (next: Ledger) => void
}

async function spawnOne(
  step: Extract<Step, { kind: 'spawn' }>,
  state: SpawnState,
  deps: ExecuteDeps,
): Promise<string> {
  const { frame, key } = step
  const { brief, ...shown } = frame
  if (!intentRecorded(state.ledger, key, frame.name))
    return `not spawned ${frame.name}: no spawning claim recorded for ${claimKey(key)}`
  deps.log('burndown_spawn_intent', { ...shown, briefChars: brief.length })
  let reply: SpawnReply
  try {
    reply = await deps.spawn(frame)
  } catch (err) {
    // The frame may have landed; the claim stays `spawning` and the next tick finds the row by name.
    return `spawn ${frame.name} unanswered (${(err as Error).message}); left spawning for the next tick`
  }
  deps.log('burndown_spawn_result', {
    name: frame.name,
    ok: reply.ok,
    reason: reply.reason,
    code: reply.code,
  })
  if (reply.ok) {
    const patch = { agentId: reply.agentId }
    state.save(
      clearLiveness(
        applyActions(state.ledger, [{ kind: 'update', key, patch }], deps.now),
        key,
        spawnAction(frame),
      ),
    )
    return `spawned ${frame.name} (${reply.agentId ?? '?'}) as ${frame.profile} on ${frame.configDir}`
  }
  return refused(step, reply, state, deps)
}

/** A retryable refusal is undone for free; any other spends the budget, undone within it and parked once spent. */
function refused(
  { frame, key }: Extract<Step, { kind: 'spawn' }>,
  reply: SpawnReply,
  { start, ledger, save }: SpawnState,
  deps: ExecuteDeps,
): string {
  const reason = reply.reason ?? 'refused without a reason'
  if (reply.retryable === true) {
    save(undoIntent(ledger, start, key))
    return `not spawned ${frame.name}: waiting: ${reply.code ?? reason}; retried next tick`
  }
  const spent = spend(ledger, key, spawnAction(frame), factFingerprint(frame), reason, deps.now)
  if (spent.verdict === 'retry') {
    save(undoIntent(spent.ledger, start, key))
    return `not spawned ${frame.name}: ${refusalReason(frame, reason)}; refused ${spent.n}/${LIVENESS_LIMIT}, retried next tick`
  }
  const detail = `${spent.n} refusals with unchanged facts; last ${refusalReason(frame, maskText(reason))}`
  save(applyActions(spent.ledger, [parkUpdate(key, 'retry-spent', detail)], deps.now))
  return `not spawned ${frame.name}: retry-spent: ${detail}`
}

/** The liveness action a register spends under: one budget per claim. */
const REGISTER_ACTION = 'register:shepherd'

/**
 * A refusal spends the budget and leaves the claim `shepherding`, so the next tick registers again; the third with
 * an unchanged PR head stalls it, since burndown never merges. An unanswered register spends nothing.
 */
function registerOne(
  step: Extract<Step, { kind: 'register' }>,
  { ledger, save }: Pick<SpawnState, 'ledger' | 'save'>,
  deps: ExecuteDeps,
): string {
  const { key, registration } = step
  const ref = targetRef(registration.target)
  const reply = deps.register(registration)
  deps.log('burndown_shepherd_register', { pr: ref, task: registration.task, ...reply })
  if (reply.ok) {
    save(clearLiveness(ledger, key, REGISTER_ACTION))
    return `registered ${ref} with Shepherd for ${claimKey(key)}`
  }
  if (!reply.refused) return `register ${ref} with Shepherd failed (${reply.reason}); retried next tick`
  const prHead = ledger.claims.find(c => c.phase !== 'done' && sameClaim(c, key))?.prHead
  const spent = spend(
    ledger,
    key,
    REGISTER_ACTION,
    factFingerprint({ registration, prHead }),
    reply.reason,
    deps.now,
  )
  if (spent.verdict === 'retry') {
    save(spent.ledger)
    return `not registered ${ref}: Shepherd refused (${reply.reason}); refused ${spent.n}/${LIVENESS_LIMIT}, retried next tick`
  }
  const detail = `Shepherd refused ${ref} ${spent.n} times with unchanged facts (${maskText(reply.reason)}); burndown does not merge, so the PR is left for the owner`
  const park = parkUpdate(key, 'retry-spent', detail)
  save(
    applyActions(spent.ledger, [{ ...park, patch: { ...park.patch, stalledClass: 'gate-trip' } }], deps.now),
  )
  return `not registered ${ref}: retry-spent: ${detail}`
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
