import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { resolveWorktreeBudget } from '../../config.js'
import { burndownConfigPath, burndownLedgerPath, burndownPausePath } from '../../paths.js'
import { activeWorkRoot } from '../active-work.js'
import { DEFAULT_WORKTREE_BUDGET } from '../isolation/worktree.js'
import { advance, applyActions, type InboxMessage } from './advance.js'
import { verifySection } from './brief.js'
import { pickAccount } from './budget-gate.js'
import type { Initiative } from './eligibility.js'
import { execute, type SpawnFrame, type SpawnReply, type Step } from './execute.js'
import { heldClaims, readLedger, withLedgerLock, writeLedger, type Claim, type Ledger } from './ledger.js'
import {
  defaultBranch,
  liveBurndownAgents,
  observe,
  orphanAt,
  worktreesUnder,
  worktreeUse,
  type Roster,
} from './observe.js'
import { plan, type Capacity, type Plan } from './plan.js'
import { accountDir, loadTickConfig, readTaskText, type TickConfig } from './source.js'
import { stepsForActions, stepsForDispatch, type StepContext } from './steps.js'
import { loadWorld, type World } from './tick.js'

/**
 * `agent-chat burndown tick --once`: one pass under the ledger lock. Observe
 * every held claim, advance it one phase, then dispatch new work inside the
 * tick's own ceilings. The broker treats this unregistered connection as the
 * human, so it applies no spawn-rate or cwd check: these ceilings are the bound.
 */

export interface TickBroker {
  roster: () => Promise<Roster>
  inboxSince: (name: string, afterId: number) => Promise<InboxMessage[]>
  spawn: (frame: SpawnFrame) => Promise<SpawnReply>
  retire: (name: string) => Promise<SpawnReply>
}

export interface TickOptions {
  dryRun: boolean
  broker: TickBroker
  now?: Date
  root?: string
  log?: (event: string, detail: Record<string, unknown>) => void
}

/** Shown in dry-run briefs when no `reportTo` is configured; a real tick refuses instead. */
const UNSET_REPORT_TO = '<reportTo unset>'

/** Why the tick may not act at all, or undefined when it may. */
export function stopReason(config: TickConfig, paused: boolean): string | undefined {
  if (!config.enabled) return `burndown is disabled (enabled is not true in ${burndownConfigPath()})`
  if (paused)
    return `burndown is paused (${burndownPausePath()} exists; \`agent-chat burndown resume\` clears it)`
  if (config.reportTo === undefined)
    return `no reportTo in ${burndownConfigPath()}: name the registered session that receives agents' reports`
  return undefined
}

export async function tickFromDisk(opts: TickOptions): Promise<string[]> {
  const config = loadTickConfig(burndownConfigPath())
  const stop = stopReason(config, fs.existsSync(burndownPausePath()))
  if (stop !== undefined && !opts.dryRun) return [stop]
  const head = stop === undefined ? [] : [`${stop}; dry run proceeds anyway`]
  const locked = await withLedgerLock(burndownLedgerPath(), () => runTick(config, opts))
  if (!locked.ran) return [...head, `another tick holds the ledger lock (pid ${locked.holder}); did nothing`]
  return [...head, ...locked.value]
}

async function runTick(config: TickConfig, opts: TickOptions): Promise<string[]> {
  const now = opts.now ?? new Date()
  const ledger = readLedger(burndownLedgerPath())
  const { steps, notes } = await decide(config, opts, ledger, now)
  if (opts.dryRun)
    return [`burndown tick at ${now.toISOString()} (dry run)`, ...steps.map(describe), ...notes]
  const executed = await execute(steps, ledger, {
    ledgerFile: burndownLedgerPath(),
    spawn: opts.broker.spawn,
    retire: opts.broker.retire,
    log: opts.log ?? logEvent,
    now,
  })
  writeLedger(burndownLedgerPath(), { ...executed.ledger, lastTickAt: now.toISOString() })
  return [`burndown tick at ${now.toISOString()}`, ...executed.lines, ...notes]
}

/** Observe, advance and plan: every step the tick would take, in order, and a note for everything it would not. */
async function decide(
  config: TickConfig,
  opts: TickOptions,
  ledger: Ledger,
  now: Date,
): Promise<{ steps: Step[]; notes: string[] }> {
  const root = opts.root ?? activeWorkRoot()
  const roster = await opts.broker.roster()
  const world = loadWorld(now, root)
  const held = heldClaims(ledger)
  const { observations, unread } = await observe(held, roster, { inboxSince: opts.broker.inboxSince, root })
  const ctx = stepContext(world, config, now, root)
  const agents = agentCapacity(config, ledger.claims, roster)
  const advanced = stepsForActions(advance(held, observations, now), ledger, ctx, agents.agents)
  const kept = advanced.steps.flatMap(s => (s.kind === 'ledger' ? s.actions : []))
  const planned = plan({
    ...world,
    ledger: applyActions(ledger, kept, now),
    capacity: worktreeCapacity(config, { ...agents, agents: agents.agents - advanced.spawns }),
    orphan: (repo, name) => orphanAt(repo, name),
  })
  const dispatched = planned.dispatch.map(d => stepsForDispatch(d, ctx))
  const notes = [
    ...unread.map(u => `unread ${u}`),
    ...advanced.deferred.map(d => `deferred ${d}`),
    ...dispatched.flatMap(d => (typeof d === 'string' ? [`not dispatched: ${d}`] : [])),
    ...refusalLines(planned),
  ]
  return { steps: [...advanced.steps, ...dispatched.flatMap(d => (typeof d === 'string' ? [] : d))], notes }
}

/** New agents this tick may start: under `maxAgents`, and under the broker's free slots less a reserve. */
export function agentCapacity(
  config: TickConfig,
  claims: Claim[],
  roster: Roster,
): Pick<Capacity, 'agents' | 'agentsReason'> {
  const live = liveBurndownAgents(claims, roster)
  const slots = roster.slots
  const free = slots === undefined ? 0 : slots.cap - slots.held - config.reserveSlots
  const broker =
    slots === undefined
      ? 'broker reported no slot reading, so none are assumed free'
      : `broker slots ${slots.held}/${slots.cap} held, ${config.reserveSlots} kept free`
  return {
    agents: Math.max(0, Math.min(config.maxAgents - live, free)),
    agentsReason: `${live} of maxAgents ${config.maxAgents} burndown agents alive; ${broker}`,
  }
}

function worktreeCapacity(config: TickConfig, agents: Pick<Capacity, 'agents' | 'agentsReason'>): Capacity {
  const budget = resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)
  const cache = new Map<string, ReturnType<Capacity['worktrees']>>()
  return {
    ...agents,
    agents: Math.max(0, agents.agents),
    worktrees: repo => {
      const known = cache.get(repo) ?? worktreeUse(worktreesUnder(repo), budget, config)
      cache.set(repo, known)
      return known
    },
  }
}

function stepContext(world: World, config: TickConfig, now: Date, root: string): StepContext {
  const facts = new Map<string, { defaultBranch: string; verifySteps?: string }>()
  return {
    now,
    root,
    initiatives: new Map(world.initiatives.map(i => [i.slug, i])),
    tasks: world.tasks,
    reportTo: config.reportTo ?? UNSET_REPORT_TO,
    repoFacts: repo => {
      const known = facts.get(repo) ?? repoFacts(repo)
      facts.set(repo, known)
      return known
    },
    account: initiative => openAccount(initiative, world),
    configDir: account => accountDir(account),
    trust: world.trust,
    taskText: (slug, id) => readTaskText(root, slug, id),
    readFile: file => readOrUndefined(file),
  }
}

function repoFacts(repo: string): { defaultBranch: string; verifySteps?: string } {
  const claudeMd = readOrUndefined(path.join(repo, 'CLAUDE.md'))
  const verifySteps = claudeMd === undefined ? undefined : verifySection(claudeMd)
  return { defaultBranch: defaultBranch(repo), ...(verifySteps === undefined ? {} : { verifySteps }) }
}

/** The gate for a successor or reviewer, which run on opus: a sonnet-only account is closed to them. */
function openAccount(initiative: Initiative, world: World): { account: string } | { closed: string } {
  const named = initiative.autonomy?.accounts.length ? initiative.autonomy.accounts : [initiative.profile]
  const allowed = named.filter((a): a is string => a !== undefined)
  const { chosen, closed } = pickAccount(allowed, world.rules, world.readings, world.gate)
  if (chosen === undefined)
    return { closed: closed.map(c => `${c.account}: ${c.reason}`).join('; ') || 'no account' }
  if (chosen.sonnetOnly) return { closed: `${chosen.account} is above 85% seven_day, sonnet only` }
  return { account: chosen.account }
}

const readOrUndefined = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function describe(step: Step): string {
  if (step.kind === 'retire') return `would retire ${step.names.join(', ')}`
  if (step.kind === 'ledger')
    return `would record ${step.actions.map(a => (a.kind === 'add' ? `add ${a.claims.map(c => c.taskId).join(',')}` : `${a.kind} ${a.key.taskId}${a.key.slice ?? ''}`)).join('; ')}`
  const f = step.frame
  const extra = [f.worktree && `adopting ${f.worktree}`, f.predecessor && `after ${f.predecessor}`].filter(
    Boolean,
  )
  return `would spawn ${f.name} as ${f.profile} (${f.surface}) on ${f.configDir} in ${f.cwd}${extra.length > 0 ? `, ${extra.join(', ')}` : ''}; brief ${f.brief.length} chars`
}

function refusalLines(planned: Plan): string[] {
  return planned.refusals.map(
    r => `refused ${r.initiative}${r.task === undefined ? '' : ` ${r.task}`} [${r.kind}]: ${r.reason}`,
  )
}
