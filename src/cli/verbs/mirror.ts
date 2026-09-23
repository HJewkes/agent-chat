import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { cliEntry, mirrorLogDir, mirrorPlistPath } from '../../paths.js'
import { loadMirrorConfig, readAsToken } from '../../mirror/config.js'
import { jobState, startJob, stopJob, systemLaunchctl, type JobControl } from '../../mirror/launchd.js'
import { mirrorJobEnv, renderMirrorPlist } from '../../mirror/plist.js'
import { describeMirror, readMirrorFacts } from '../../mirror/status.js'
import { addVerb, defineVerb, Report } from '../command.js'

const control = (dryRun = false): JobControl => ({
  launchctl: systemLaunchctl,
  uid: process.getuid?.() ?? 0,
  dryRun,
})

/** The config and the env file are checked here, so a broken setup fails now rather than in a crash loop. */
function preflight(): string | null {
  try {
    loadMirrorConfig()
    readAsToken()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export const renderPlist = (): string =>
  renderMirrorPlist({
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    logDir: mirrorLogDir(),
    env: mirrorJobEnv(process.env),
  })

export const mirrorStartVerb = defineVerb({
  name: 'mirror.start',
  description: 'install or refresh the launchd job and start it',
  args: z.object({ dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: { long: '--dry-run', description: 'print the plist and launchctl calls; change nothing' },
    },
  },
  async run({ dryRun }) {
    const refusal = preflight()
    if (refusal !== null) return { ok: false, lines: [], errors: [`Not started: ${refusal}`] }
    const plist = renderPlist()
    const paths = { plist: mirrorPlistPath(), logDir: mirrorLogDir() }
    const result = startJob(paths, plist, control(dryRun === true))
    return dryRun === true ? { ok: true, lines: [plist, ...result.lines] } : result
  },
})

export const mirrorStopVerb = defineVerb({
  name: 'mirror.stop',
  description: 'stop the launchd job and keep it from starting at login',
  args: z.object({}),
  result: Report,
  async run() {
    return stopJob(control())
  },
})

export const mirrorStatusVerb = defineVerb({
  name: 'mirror.status',
  description: 'config, env file mode, launchd state and status-file freshness',
  args: z.object({}),
  result: Report,
  async run() {
    const job = jobState(control())
    const check = describeMirror(readMirrorFacts())
    const launchd = job.loaded
      ? `loaded${job.pid === null ? ', not running' : `, pid ${job.pid}`}`
      : 'not loaded'
    return {
      ok: check.status !== 'fail',
      lines: [`${check.status.padEnd(5)} ${check.detail}`, `launchd ${launchd}`],
    }
  },
})

/** `run` is hidden: it is what launchd starts, not something a person types. */
export function addMirrorCommands(program: Commander): void {
  const mirror = program
    .command('mirror')
    .description('project the human queue into a Matrix room and fold phone verdicts back')

  addVerb(mirror, mirrorStartVerb)
  addVerb(mirror, mirrorStopVerb)
  addVerb(mirror, mirrorStatusVerb)

  mirror.command('run', { hidden: true }).action(async () => {
    const { runMirrorDaemon } = await import('../../mirror/run.js')
    const controller = new AbortController()
    process.once('SIGTERM', () => controller.abort())
    process.once('SIGINT', () => controller.abort())
    await runMirrorDaemon(controller.signal)
  })
}
