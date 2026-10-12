import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Anchored to the executable: argv[0], or the script after a shell or node interpreter (the git
// and gh shims run under sh), so a process that only mentions these commands in its arguments
// (a claude prompt) never matches (CC-665). Only after a shell may the script path hold spaces,
// as bin/merge's does under "Application Support". Ported from scripts/restart-window.sh (CC-1179).
const LAUNCHER =
  '^(([^ ]*/)?(ba|z)?sh( -[^ ]+)* ([^ /]*(/[^/ ]+( [^/ -][^/ ]*)*)*/)?|(([^ ]*/)?node( -[^ ]+)* )?([^ ]*/)?)'

export const PUSH_RE = new RegExp(
  `${LAUNCHER}(git( -[Cc] [^ ]+( [^ -][^ ]*)*| --[^ ]+)* push|git-remote-https?)( |$)`,
)
export const MERGE_RE = new RegExp(
  `${LAUNCHER}(seat-merge|bin/merge|gh( -[^ ]+( [^ -][^ ]*)?)* pr merge|(agent-chat|cli\\.js|index\\.js) gh-write)( |$)`,
)

export interface InflightProcs {
  pushes: number[]
  merges: number[]
}

/** Pure. `lines` are `pid argv` rows as `ps -eo pid=,args=` prints them. */
export function inflight(lines: string[]): InflightProcs {
  const pushes = new Set<number>()
  const merges = new Set<number>()
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!row) continue
    const pid = Number(row[1])
    if (PUSH_RE.test(row[2]!)) pushes.add(pid)
    if (MERGE_RE.test(row[2]!)) merges.add(pid)
  }
  const sorted = (pids: Set<number>) => [...pids].sort((a, b) => a - b)
  return { pushes: sorted(pushes), merges: sorted(merges) }
}

/** The live process table, full width so a long argv is never cut before its command. */
export async function listProcs(timeoutMs = 10_000): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-ww', '-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
  return stdout.split('\n').filter(line => line.trim() !== '')
}
