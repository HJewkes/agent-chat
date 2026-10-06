import fs from 'node:fs'
import os from 'node:os'
import { loadTickConfig } from '../../agents/burndown/source.js'
import { TICK_INTERVAL_SECONDS } from '../../agents/burndown/tick-status.js'
import {
  describeLaunchd,
  launchdControl,
  unitControl,
  usesSystemd,
  type JobHost,
} from '../../mirror/job-host.js'
import { jobState, startJob, stopJob, type JobControl } from '../../mirror/launchd.js'
import { burndownJob, jobEnv, launchdJobRefusals, renderPlist, type JobSpec } from '../../mirror/plist.js'
import { installUnits, uninstallUnits, unitStatus } from '../../mirror/systemd.js'
import { renderUnits, unitName, type RenderedUnits } from '../../mirror/systemd-unit.js'
import {
  BURNDOWN_LABEL,
  burndownConfigPath,
  burndownLogDir,
  burndownPausePath,
  burndownPlistPath,
  cliEntry,
  linuxJobLogDir,
} from '../../paths.js'
import type { Report } from '../command.js'

/** Section 7 of the slice-4 plan: every item a human checks before the tick may spawn unattended. */
const SIGN_OFF_CHECKLIST = [
  "Sign-off checklist (CC-slice4-plan.md section 7) — every item is yours to check, not the tick's:",
  '[ ] Settings allowlist covers git fetch/merge --ff-only/add/commit, git push -u origin agent-chat/*,' +
    ' npm run format(:check)/typecheck/build, npx vitest run, gh pr create/view/checks (not gh pr merge).',
  '[ ] Decider deployed in a restart window, or explicitly waived.',
  '[ ] Lean bd-* profiles live after a broker restart; R3 bootstrap measurement read.',
  '[ ] Slot ceiling: burndown.config.json maxAgents set and below free broker slots.',
  '[ ] Worktree ceiling: maxWorktreesPerRepo and reserveWorktrees set per opted-in repo; orphans reclaimed.',
  '[ ] Trust: burndown plan shows no trust refusal; the installed CLI is still the pinned version.',
  '[ ] Budget: burndown.config.json reserves reviewed; billing account(s) confirmed.',
  '[ ] reportTo set to a registered session in burndown.config.json (a real tick refuses without it).',
  '[ ] Opt-in scope: exactly one initiative, lanes: 1, grants: [].',
  '[ ] Three supervised `burndown tick --once` runs done by hand; `burndown status` read after each.',
  '[ ] Seats mode: per listed seat, three dry runs each followed by `burndown seats compare`, all exiting 0.',
  '[ ] Seats mode: each listed seat no longer dispatches scored work itself; no brief has an autonomy: block.',
  '[ ] Kill switch known: `burndown pause` stops new spawns; `burndown uninstall` removes the job.',
]

const linuxLogDir = (): string => linuxJobLogDir(unitName(BURNDOWN_LABEL))

/** Uninstall and status need only the unit names and kinds, never the refusals install applies. */
const installedUnits = (): RenderedUnits =>
  renderUnits(
    burndownJob({
      label: BURNDOWN_LABEL,
      nodePath: process.execPath,
      cliEntry: cliEntry(),
      env: {},
      logDir: linuxLogDir(),
      intervalSeconds: TICK_INTERVAL_SECONDS,
    }),
  )

type Preflight = { refused: Report } | { lines: string[]; spec: (logDir: string) => JobSpec }

/** The checklist, then the config and job-path refusals both platforms share. */
function preflight(): Preflight {
  const lines = [...SIGN_OFF_CHECKLIST]
  if (!loadTickConfig(burndownConfigPath()).enabled) {
    return { refused: { ok: false, lines, errors: ['refused: burndown.config.json has enabled: false'] } }
  }
  const job = { nodePath: process.execPath, cliEntry: cliEntry(), env: jobEnv(process.env) }
  const errors = launchdJobRefusals({ ...job, tmpdir: os.tmpdir() })
  if (errors.length > 0) return { refused: { ok: false, lines, errors } }
  const spec = (logDir: string): JobSpec =>
    burndownJob({ ...job, label: BURNDOWN_LABEL, logDir, intervalSeconds: TICK_INTERVAL_SECONDS })
  return { lines, spec }
}

const withChecklist = (lines: string[], rendered: string[], result: Report, dryRun: boolean): Report =>
  dryRun
    ? { ok: true, lines: [...lines, ...rendered, ...result.lines] }
    : { ...result, lines: [...lines, ...result.lines] }

/** The darwin install body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownInstall(dryRun: boolean, control: JobControl): Report {
  const checked = preflight()
  if ('refused' in checked) return checked.refused
  const plist = renderPlist(checked.spec(burndownLogDir()))
  const paths = { plist: burndownPlistPath(), logDir: burndownLogDir() }
  return withChecklist(checked.lines, [plist], startJob(paths, plist, control), dryRun)
}

export function burndownInstallOn(host: JobHost): Report {
  if (!usesSystemd(host)) return burndownInstall(host.dryRun, launchdControl(host, BURNDOWN_LABEL))
  const checked = preflight()
  if ('refused' in checked) return checked.refused
  const units = renderUnits(checked.spec(linuxLogDir()))
  // An elapsed OnBootSec fires as the timer starts, so the first tick runs at install as launchd's kickstart does.
  const result = installUnits(unitControl(host), units, linuxLogDir())
  return withChecklist(checked.lines, [units.service, units.timer ?? ''], result, host.dryRun)
}

/** The darwin uninstall body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownUninstall(control: JobControl): Report {
  return stopJob(control)
}

export function burndownUninstallOn(host: JobHost): Report {
  if (!usesSystemd(host)) return burndownUninstall(launchdControl(host, BURNDOWN_LABEL))
  return uninstallUnits(unitControl(host), installedUnits())
}

const configLine = (): string =>
  `config enabled=${loadTickConfig(burndownConfigPath()).enabled} paused=${fs.existsSync(burndownPausePath())}`

/** The darwin job-status body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownJobStatus(control: JobControl): Report {
  const launchd = describeLaunchd(jobState(control))
  return { ok: true, lines: [`launchd ${launchd}`, `plist ${burndownPlistPath()}`, configLine()] }
}

export function burndownJobStatusOn(host: JobHost): Report {
  if (!usesSystemd(host)) return burndownJobStatus(launchdControl(host, BURNDOWN_LABEL))
  return { ok: true, lines: [...unitStatus(unitControl(host), installedUnits()), configLine()] }
}
