import { execFileSync } from 'node:child_process'
import { hostProbe, type ProcessProbe } from './detached-reap.js'

/** CC-488: what run-agent can see of another process already holding a conversation. */
export interface LaunchProbe extends ProcessProbe {
  /** `pid command` for every process, as `ps` prints it. */
  listProcesses: () => Array<{ pid: number; command: string }>
}

const psList = (): Array<{ pid: number; command: string }> => {
  const out = execFileSync('ps', ['-ww', '-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return out
    .split('\n')
    .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ pid: Number(m[1]), command: m[2] ?? '' }))
}

export const hostLaunchProbe: LaunchProbe = { ...hostProbe, listProcesses: psList }

const runsAgent = (command: string, agentId: string): boolean =>
  command.split(/\s+/).some((word, i, words) => word === 'run-agent' && words[i + 1] === agentId)

/**
 * The pid of another process running this agent or holding this session, else undefined.
 * `ignore` holds this process and its parent, which is the shell running the relaunch script.
 */
export function holderOf(
  agentId: string,
  sessionId: string,
  ignore: readonly number[],
  probe: LaunchProbe = hostLaunchProbe,
  configDir?: string,
): number | undefined {
  try {
    const other = probe.listProcesses().find(p => !ignore.includes(p.pid) && runsAgent(p.command, agentId))
    if (other !== undefined) return other.pid
    const records = probe.sessionRecords(configDir === undefined ? [] : [configDir])
    return records.find(r => r.sessionId === sessionId && !ignore.includes(r.pid) && probe.isAlive(r.pid))
      ?.pid
  } catch {
    return undefined
  }
}
