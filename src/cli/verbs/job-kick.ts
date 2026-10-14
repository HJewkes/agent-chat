import path from 'node:path'
import { AGENT_ID_ENV } from '../../launch-identity.js'
import { home } from '../../paths.js'
import type { ClientMessage } from '../../protocol.js'
import type { Report } from '../command.js'
import { withRunningBroker, type Reply } from './seat-broker.js'

/**
 * CC-1151: a hand-run tick, watchdog or heartbeat check from an agent's shell runs nothing in-process,
 * where the agent's PATH, GH_*, HOME, git env, CLAUDE_CONFIG_DIR and NODE_OPTIONS would steer it. It
 * sends the broker a `job_kick` frame naming the job, and the broker runs it in its own env.
 */
export type JobKickFrame = Extract<ClientMessage, { t: 'job_kick' }>

/** Without an agent id (the units, the owner's shell) every site runs in-process as before. */
export const kicksInBroker = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env[AGENT_ID_ENV] ?? '') !== ''

/** The flags an agent may not pass, because the broker runs the job with its own defaults. */
export function refusedKickFlags(
  job: JobKickFrame['job'],
  flags: Record<string, unknown>,
): Report | undefined {
  const named = Object.entries(flags)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([flag]) => flag)
  if (named.length === 0) return undefined
  return {
    ok: false,
    lines: [],
    errors: [
      `${named.join(', ')} refused from an agent shell (${AGENT_ID_ENV} set): ${job} runs in the broker ` +
        'with its own defaults',
    ],
  }
}

const logFile = (job: JobKickFrame['job']): string =>
  path.join(home(), job === 'burndown_tick' ? 'burndown-kick.log' : 'job-kick.log')

export async function sendJobKick(frame: JobKickFrame): Promise<Report> {
  const res = await withRunningBroker(
    async client => (await client.request(frame, 'job_kick_result')) as Reply<'job_kick_result'>,
  )
  const named = frame.seat === undefined ? frame.job : `${frame.job} --seat ${frame.seat}`
  if (!res.ok) return { ok: false, lines: [], errors: [`broker refused ${named}: ${res.detail}`] }
  return {
    ok: true,
    lines: [`kicked ${named} in the broker: ${res.detail}; output in ${logFile(frame.job)}`],
  }
}
