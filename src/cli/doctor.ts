import { type Check, worstStatus } from '../broker/doctor.js'
import type { Report } from './command.js'

const MARK: Record<Check['status'], string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

export function describeDoctor(checks: Check[]): Report {
  const lines = checks.map(check => `${MARK[check.status]}  ${check.name.padEnd(18)} ${check.detail}`)

  const worst = worstStatus(checks)
  const failed = checks.filter(c => c.status === 'fail').length
  lines.push(
    worst === 'ok'
      ? '\nAll good.'
      : worst === 'warn'
        ? '\nNothing broken; the warnings above are states, not faults.'
        : `\n${failed} check${failed === 1 ? '' : 's'} failed.`,
  )
  // Warnings are routine (no broker running yet, no dashboard built) and must not
  // fail a preflight in a script. Only a hard fail is worth a non-zero exit.
  return { ok: worst !== 'fail', lines }
}
