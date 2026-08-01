import { type Check, runChecks, worstStatus } from '../broker/doctor.js'

const MARK: Record<Check['status'], string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

export async function doctor(): Promise<void> {
  const checks = await runChecks()
  for (const check of checks) console.log(`${MARK[check.status]}  ${check.name.padEnd(18)} ${check.detail}`)

  const worst = worstStatus(checks)
  const failed = checks.filter(c => c.status === 'fail').length
  console.log(
    worst === 'ok'
      ? '\nAll good.'
      : worst === 'warn'
        ? '\nNothing broken; the warnings above are states, not faults.'
        : `\n${failed} check${failed === 1 ? '' : 's'} failed.`,
  )
  // Warnings are routine (no broker running yet, no dashboard built) and must not
  // fail a preflight in a script. Only a hard fail is worth a non-zero exit.
  if (worst === 'fail') process.exit(1)
}
