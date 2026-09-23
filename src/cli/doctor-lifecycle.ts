import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { TOKEN_HEADER, type ErrorResponse, type LifecycleReport } from '../api-contract.js'
import { gather, reportFrom } from '../agents/ledger/verifier.js'
import { EventLog } from '../broker/event-log.js'
import { readMeta } from '../broker/lifecycle.js'
import { readToken } from '../broker/token.js'
import { defaultPort, home } from '../paths.js'

/** Git gets two seconds per repository, concurrently; the rest is local reads. */
const FETCH_TIMEOUT_MS = 10_000

/**
 * `agent-chat doctor lifecycle`, CC-118's verifier on demand. A subcommand rather
 * than `doctor --lifecycle` because it has an option of its own (`--offline`) and
 * an exit rule of its own, neither of which means anything to the preflight.
 */
export function doctorLifecycleCommand(): Command {
  return new Command('lifecycle')
    .description('compare the shadow lifecycle ledger with the supervisor, the event log and git')
    .option('--offline', 'skip the broker: compare the ledger, the event log, runtime.json and git only')
    .action(doctorLifecycle)
}

async function doctorLifecycle(options: { offline?: boolean }): Promise<void> {
  const outcome = options.offline ? await offlineReport() : await brokerReport()
  if (typeof outcome === 'string') {
    console.error(outcome)
    process.exit(2)
  }
  for (const line of renderReport(outcome)) console.log(line)
  if (outcome.unclassified > 0 || (outcome.shadow_errors ?? 0) > 0) process.exit(1)
}

/** A report, or the one line saying why there is none. */
async function brokerReport(): Promise<LifecycleReport | string> {
  const port = readMeta()?.port ?? defaultPort()
  const token = readToken()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/lifecycle`, {
      headers: token ? { [TOKEN_HEADER]: token } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) return (await res.json()) as LifecycleReport
    const body = (await res.json().catch(() => null)) as ErrorResponse | null
    return `broker refused (${res.status}): ${body?.error ?? 'this broker predates /api/lifecycle'}`
  } catch (err) {
    return `broker not answering on port ${port} (${(err as Error).message}); try --offline`
  }
}

async function offlineReport(): Promise<LifecycleReport | string> {
  const file = path.join(home(), 'events.db')
  if (!fs.existsSync(file)) return `no event log at ${file}`
  const log = new EventLog(file)
  try {
    const { input, shadow } = await gather({ db: log.ledgerHandle(), events: log })
    return reportFrom(input, shadow, null, Date.now())
  } finally {
    log.close()
  }
}

export function renderReport(report: LifecycleReport): string[] {
  const rows = report.items.map(
    item =>
      `${item.unclassified ? 'FAIL' : 'ok  '}  ${item.class}  ${item.name ?? '-'}  ${item.id}  ${item.detail}`,
  )
  const unlisted = report.unlisted_repos.map(
    repo => `warn  git could not list ${repo}; its allocations went unchecked`,
  )
  const errors = report.shadow_errors === null ? 'not read offline' : String(report.shadow_errors)
  return [
    ...rows,
    ...unlisted,
    `shadow ${report.shadow}: ${report.items.length} divergences, ${report.unclassified} unclassified, shadow errors ${errors}`,
  ]
}
