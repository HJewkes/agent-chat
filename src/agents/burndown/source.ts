import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { frontmatterField, listField, parseAutonomy, taskScalars } from '../active-work.js'
import { readAccountBudget } from '../budget.js'
import { profileDir } from '../config-dir.js'
import { DEFAULT_RULES, type AccountReading, type AccountRule } from './budget-gate.js'
import { Route } from './exception.js'
import type { Initiative, Task } from './eligibility.js'

/** Reads the tick's inputs off disk. Read-only: active-work files, status caches and the burndown config. */

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const expandHome = (p: string, home: string): string =>
  p === '~' || p.startsWith('~/') ? path.join(home, p.slice(1)) : p

const numberOr = (raw: string | undefined): number | undefined => {
  const n = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function readInitiatives(root: string, home = os.homedir()): Initiative[] {
  let slugs: string[]
  try {
    slugs = fs.readdirSync(root).filter(s => !s.startsWith('.'))
  } catch {
    return []
  }
  return slugs.flatMap(slug => {
    const brief = readText(path.join(root, slug, 'brief.md'))
    if (brief === undefined) return []
    const autonomy = parseAutonomy(brief)
    const fields = {
      state: frontmatterField(brief, 'state'),
      rank: numberOr(frontmatterField(brief, 'rank')),
      profile: frontmatterField(brief, 'profile'),
    }
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    const repo = autonomy?.repo === undefined ? {} : { repo: expandHome(autonomy.repo, home) }
    return [{ slug, ...defined, ...(autonomy === undefined ? {} : { autonomy: { ...autonomy, ...repo } }) }]
  })
}

export function parseTask(text: string, fallbackId: string): Task {
  const s = taskScalars(text)
  const fields = {
    status: s.status,
    priority: numberOr(s.priority),
    estimate: numberOr(s.estimate),
    doneWhen: s.done_when === '' || s.done_when === 'null' ? undefined : s.done_when,
  }
  const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
  return { id: s.id ?? fallbackId, title: s.title ?? '(untitled)', tags: listField(text, 'tags'), ...defined }
}

export function readTasks(root: string, slug: string): Task[] {
  const dir = path.join(root, slug, 'tasks')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'))
  } catch {
    return []
  }
  return files.flatMap(file => {
    const text = readText(path.join(dir, file))
    return text === undefined ? [] : [parseTask(text, file.replace(/\.yml$/, ''))]
  })
}

/** The task file's text for `id`, verbatim, for a brief; undefined when no file carries that id. */
export function readTaskText(root: string, slug: string, id: string): string | undefined {
  const dir = path.join(root, slug, 'tasks')
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter(name => name.endsWith('.yml'))
  } catch {
    return undefined
  }
  for (const file of files) {
    const text = readText(path.join(dir, file))
    if (text !== undefined && parseTask(text, file.replace(/\.yml$/, '')).id === id) return text
  }
  return undefined
}

const Rule = z.object({
  reserve_seven_day: z.number().min(0).max(100),
  ceiling_five_hour: z.number().min(0).max(100),
  night: z.object({ reserve_seven_day: z.number().min(0).max(100) }).optional(),
})
const count = z.number().int().nonnegative()
const Config = z.object({
  accounts: z.record(z.string(), Rule).optional(),
  enabled: z.boolean().default(false),
  /** Burndown agents alive at once, across every initiative. */
  maxAgents: count.default(3),
  /** Broker agent slots the tick leaves free for the human's own spawns. */
  reserveSlots: count.default(2),
  maxWorktreesPerRepo: count.default(3),
  /** Worktrees under each repo's budget the tick never takes. */
  reserveWorktrees: count.default(3),
  /** The registered session a spawned agent `chat_send`s its report to; the tick itself reads the transcript. */
  reportTo: z.string().min(1).optional(),
  /** The durable decider the tick wakes for waiting questions; the human spawns it and sets its id once. */
  decider: z
    .object({ name: z.string().min(1), maxPerHour: count.default(4), maxPerDay: count.default(24) })
    .optional(),
  /** Who handles each exception class; `gate-trip` has no key because an owner gate is never triaged. */
  exceptions: z
    .object({
      route: z
        .object({ stalled: Route.default('owner'), failed: Route.default('owner') })
        .strict()
        .default({ stalled: 'owner', failed: 'owner' }),
      /** The triage job (CC-649); unset, or without an account, a `triage` dial falls back to the owner. */
      triage: z
        .object({
          profile: z.string().min(1).default('triager'),
          account: z.string().min(1).optional(),
          maxPerDay: count.default(12),
          maxMinutes: count.default(30),
        })
        .strict()
        .optional(),
    })
    .strict()
    .default({ route: { stalled: 'owner', failed: 'owner' } }),
  /** The triage ladder (CC-660); off, it only notes what it would do. */
  ladder: z
    .object({ enabled: z.boolean().default(false) })
    .strict()
    .default({ enabled: false }),
  /** Seat names for CC-205 seats-mode dispatch; empty means none. */
  seats: z.array(z.string().min(1)).default([]),
})
export type TickConfig = Omit<z.infer<typeof Config>, 'accounts'>

function parseConfig(file: string): z.infer<typeof Config> | undefined {
  const raw = readText(file)
  if (raw === undefined) return undefined
  const parsed = Config.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`burndown config ${file} is malformed: ${parsed.error.message}`)
  return parsed.data
}

/** The design's starting numbers when no config file or no `accounts` exists; a malformed file throws. */
export function loadRules(file: string): Record<string, AccountRule> {
  return (parseConfig(file)?.accounts as Record<string, AccountRule> | undefined) ?? DEFAULT_RULES
}

/** The tick's switches and ceilings; absent means disabled. */
export function loadTickConfig(file: string): TickConfig {
  const { accounts: _accounts, ...config } = parseConfig(file) ?? Config.parse({})
  return config
}

/** The Claude config dir an account name resolves to, the way a spawn's `profile` would. */
export const accountDir = (account: string, env = process.env, home = os.homedir()): string =>
  profileDir(account, env, home)

export function readReadings(accounts: string[], now = Date.now()): Map<string, AccountReading> {
  const readings = new Map<string, AccountReading>()
  for (const account of accounts) {
    const read = readAccountBudget(accountDir(account), now)
    if (!read.found) continue
    const { seven_day, five_hour } = read.budget.rate_limits
    readings.set(account, {
      ageSeconds: read.age_seconds,
      ...(seven_day === undefined ? {} : { sevenDay: seven_day.used_pct }),
      ...(five_hour === undefined ? {} : { fiveHour: five_hour.used_pct }),
      ...(seven_day?.resets_at === undefined ? {} : { sevenDayResetsAt: seven_day.resets_at * 1000 }),
    })
  }
  return readings
}
