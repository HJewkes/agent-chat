import { format } from 'node:util'
import { z } from 'zod'
import type { HealthPayload } from '../../api-contract.js'
import { probeHealth } from '../../broker/doctor.js'
import { isProcessAlive, probeSocket, readMeta, readPidFile } from '../../broker/lifecycle.js'
import { defaultPort, socketPath } from '../../paths.js'
import { defineVerb, Report } from '../command.js'
import { parsePort } from '../service-options.js'

export interface ServiceStatus {
  /** Authoritative liveness: something answered on the unix socket. */
  socket: boolean
  /** Diagnostic only — a PID file survives `kill -9`, so it never answers "is it running". */
  pid: number | null
  meta: ReturnType<typeof readMeta>
  /** Null when the HTTP surface did not answer, which is a legible state, not a failure. */
  health: HealthPayload | null
}

/**
 * Three-stage, extending active-work's two-stage (§4.3). Each stage is collected
 * separately so "running but HTTP down" stays legible instead of collapsing into
 * one boolean.
 */
export async function collectStatus(port?: number): Promise<ServiceStatus> {
  const socket = await probeSocket()
  const meta = readMeta()
  const health = await probeHealth(port ?? meta?.port ?? defaultPort())
  return { socket, pid: readPidFile(), meta, health }
}

export const serviceStatusVerb = defineVerb({
  name: 'service.status',
  description: 'socket, pid file and /health, reported separately',
  args: z.object({ port: z.preprocess(value => parsePort(String(value)), z.number()).optional() }),
  result: Report,
  cli: {
    options: {
      port: { short: '-p', long: '--port', valueName: 'port', description: 'port to probe for /health' },
    },
  },
  async run({ port }) {
    const lines: string[] = []
    try {
      const s = await collectStatus(port)
      lines.push(`socket   ${s.socket ? 'up' : 'down'}  ${socketPath()}`)
      lines.push(
        s.pid === null
          ? 'pid      no pid file'
          : `pid      ${s.pid}${isProcessAlive(s.pid) ? '' : ' (stale — no such process)'}`,
      )
      if (s.meta) lines.push(`meta     version ${s.meta.version}  port ${s.meta.port ?? 'unbound'}`)
      lines.push(
        s.health === null
          ? 'http     no answer'
          : `http     ok  uptime ${Math.round(s.health.uptime_ms / 1000)}s  ${s.health.sessions} sessions  ${s.health.queue_open} open`,
      )
      // Only the socket answers whether it is running; PID and HTTP are diagnostic.
      return { ok: s.socket, lines }
    } catch (error) {
      // Keep already-rendered stdout and the entrypoint's legacy exit1 for all errors.
      return { ok: false, lines, errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})
