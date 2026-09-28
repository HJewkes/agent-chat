import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { frontmatterField, listField, parseAutonomy, taskScalars } from '../active-work.js'
import { readAccountBudget } from '../budget.js'
import { profileDir } from '../config-dir.js'
import { DEFAULT_RULES, type AccountReading, type AccountRule } from './budget-gate.js'
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

const Rule = z.object({
  reserve_seven_day: z.number().min(0).max(100),
  ceiling_five_hour: z.number().min(0).max(100),
  night: z.object({ reserve_seven_day: z.number().min(0).max(100) }).optional(),
})
const Config = z.object({ accounts: z.record(z.string(), Rule) })

/** The design's starting numbers when no config file exists; a malformed file throws. */
export function loadRules(file: string): Record<string, AccountRule> {
  const raw = readText(file)
  if (raw === undefined) return DEFAULT_RULES
  const parsed = Config.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`burndown config ${file} is malformed: ${parsed.error.message}`)
  return parsed.data.accounts as Record<string, AccountRule>
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
    })
  }
  return readings
}
