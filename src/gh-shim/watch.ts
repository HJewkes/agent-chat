import type { ShimRequest } from './argv.js'
import { duration } from './checks.js'
import type { ShimIo } from './commands.js'
import { asJson, runJob } from './fields.js'

type Json = Record<string, unknown>

export const runJobs = (io: ShimIo, repo: string, runId: string): Json[] =>
  (asJson(io.api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)).jobs as unknown[]).map(runJob)

const SYMBOLS: Record<string, string> = { success: '✓', skipped: '-', neutral: '-' }

function jobLine(job: Json): string {
  const status = String(job.status)
  const symbol = status === 'completed' ? (SYMBOLS[String(job.conclusion)] ?? 'X') : '*'
  const took = status === 'completed' ? duration(String(job.startedAt), String(job.completedAt)) : undefined
  return `${symbol} ${String(job.name)}${took === undefined ? '' : ` in ${took}`} (ID ${String(job.databaseId)})\n`
}

/** Polls `actions/runs/<id>` at the requested interval; prints the job summary once the run completes. */
export async function runWatch(
  io: ShimIo,
  req: Extract<ShimRequest, { kind: 'run-watch' }>,
  repo: string,
): Promise<number> {
  let run = asJson(io.api(`repos/${repo}/actions/runs/${req.runId}`))
  const already = run.status === 'completed'
  while (run.status !== 'completed') {
    await io.sleep(req.intervalSec * 1000)
    run = asJson(io.api(`repos/${repo}/actions/runs/${req.runId}`))
  }
  const conclusion = String(run.conclusion ?? '')
  const label = `Run ${String(run.name)} (${req.runId})`
  if (already) io.out(`${label} has already completed with '${conclusion}'\n`)
  else {
    io.out(`\nJOBS\n${runJobs(io, repo, req.runId).map(jobLine).join('')}\n`)
    io.out(`${conclusion === 'success' ? '✓' : 'X'} ${label} completed with '${conclusion}'\n`)
  }
  return req.exitStatus && conclusion !== 'success' ? 1 : 0
}
