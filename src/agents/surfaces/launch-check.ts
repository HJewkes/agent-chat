import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Did `run-agent` actually start in the pane just opened (CC-175)?
 *
 * The broker does not own a pane's process, so without this a launch that died
 * at the shell (`zsh: command not found: s`, exit 127, after keystrokes joined
 * the typed command) read as "still starting" for ten minutes. A pane's tty is
 * the one handle that reaches its processes, and `ps -t` answers from it.
 *
 * Only a positive answer of absence fails a launch. A tty that never appears, a
 * `ps` that errors, or a pane that has closed all mean "cannot say", and the
 * ordinary attach window keeps deciding those.
 */

/** Command lines of the processes on a tty. Rejects when it cannot tell. */
export type ProcessProbe = (tty: string) => Promise<string[]>

/** What a surface can read back off the pane it opened. */
export interface PaneReader {
  /** The pane's tty, `''` while it has none yet, undefined once the pane is gone. */
  tty: () => Promise<string | undefined>
  contents: () => Promise<string>
}

export interface LaunchCheckTiming {
  deadlineMs: number
  pollMs: number
}

export const LAUNCH_CHECK_TIMING: LaunchCheckTiming = { deadlineMs: 5_000, pollMs: 500 }

/** How much of the pane a failure reason quotes. */
const TAIL_LINES = 5

const execFileAsync = promisify(execFile)

/** `-ww` because ps otherwise cuts the line at 80 columns, before the agent id. */
export const psProbe: ProcessProbe = async tty => {
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-t', tty, '-o', 'command='], { encoding: 'utf8' })
    return stdout.split('\n').filter(line => line.trim() !== '')
  } catch (err) {
    // ps exits 1 with no output when nothing is on the tty, which is an answer.
    const failed = err as { code?: unknown; stdout?: unknown }
    if (failed.code === 1 && failed.stdout === '') return []
    throw err
  }
}

/** The node process, whose argv carries these as two words; the zsh wrapper's -c string quotes them. */
const runsAgent = (line: string, agentId: string): boolean => {
  const words = line.trim().split(/\s+/)
  return words.some((word, i) => word === 'run-agent' && words[i + 1] === agentId)
}

const TTY = /^\/dev\/tty\w+$/

type Look = 'running' | 'absent' | 'unknown'

async function lookOnce(pane: PaneReader, probe: ProcessProbe, agentId: string): Promise<Look> {
  const tty = await pane.tty()
  if (tty === undefined) return 'unknown'
  if (tty === '') return 'absent'
  if (!TTY.test(tty)) return 'unknown'
  const lines = await probe(tty.slice('/dev/'.length))
  return lines.some(line => runsAgent(line, agentId)) ? 'running' : 'absent'
}

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

const tail = (contents: string): string =>
  contents
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-TAIL_LINES)
    .join('\n')

async function failureReason(pane: PaneReader, agentId: string, deadlineMs: number): Promise<string> {
  const said = await pane.contents().then(tail, () => '')
  const within = `run-agent ${agentId} was not running in its pane ${Math.round(deadlineMs / 1000)}s after launch`
  return said === ''
    ? `${within}, and the pane showed nothing.`
    : `${within}. The pane's last lines:\n${said}`
}

async function check(
  pane: PaneReader,
  probe: ProcessProbe,
  agentId: string,
  timing: LaunchCheckTiming,
): Promise<string | undefined> {
  const attempts = Math.max(1, Math.ceil(timing.deadlineMs / timing.pollMs))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await pause(timing.pollMs)
    const look = await lookOnce(pane, probe, agentId).catch((): Look => 'unknown')
    if (look !== 'absent') return undefined
  }
  return failureReason(pane, agentId, timing.deadlineMs)
}

/**
 * Resolves with a failure reason when the launch is known to have failed, and
 * never resolves otherwise, which is the shape the supervisor's attach wait races.
 */
export function watchLaunch(
  pane: PaneReader,
  probe: ProcessProbe,
  agentId: string,
  timing: LaunchCheckTiming = LAUNCH_CHECK_TIMING,
): Promise<string> {
  return new Promise(resolve => {
    void check(pane, probe, agentId, timing).then(reason => {
      if (reason !== undefined) resolve(reason)
    })
  })
}
