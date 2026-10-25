import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type net from 'node:net'
import { psArgvReader } from './host-channels.js'

/**
 * CC-896: a session that registered before CC-880 reported no host, so the broker
 * could not tell it from a remote one and refused to signal it. The kernel can:
 * the process on the other end of a unix socket is a fact the client does not
 * supply. A forwarded socket (ssh -R) has sshd on the broker's end, never the
 * client's own process, so a peer inside the session's own process tree is local.
 */

export interface PeerPorts {
  /** The pid holding the client end of `conn`, or undefined when it cannot be established. */
  peerPid(conn: net.Socket): number | undefined
  /** Parent pid and command name of `pid`, or undefined when it cannot be read. */
  /** The command line of `pid`, or undefined when it cannot be read. */
  argv(pid: number): string | undefined
  process(pid: number): { ppid: number; comm: string } | undefined
  /** CC-1246: the session id and controlling tty (`tty_nr`, 0 for none) of `pid`, or undefined when unread. */
  terminal(pid: number): { session: number; ttyNr: number } | undefined
}

/** The MCP server sits at most a wrapper or two below Claude Code; a longer chain is not that shape. */
const MAX_DEPTH = 4

/** Whatever holds the broker's end of a forwarded socket: sshd for an inbound one, the ssh client for `ssh -R`. */
const FORWARDERS = /^(ssh|autossh|mosh|socat|ncat|netcat|nc$)/

/**
 * True only when the peer's process tree reaches `hostPid` without passing through
 * a socket forwarder (sshd, ssh, autossh, socat) and within a few steps. Anything unreadable, ambiguous or missing is false: this gates a signal.
 */
export function provePeerLocal(conn: net.Socket, hostPid: number | undefined, ports: PeerPorts): boolean {
  if (hostPid === undefined || hostPid <= 1) return false
  let pid = ports.peerPid(conn)
  if (pid === undefined || pid === hostPid) return false
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const proc = ports.process(pid)
    if (proc === undefined || FORWARDERS.test(proc.comm)) return false
    if (proc.ppid === hostPid) return !forwarderAt(hostPid, ports) && runsClaudeCode(hostPid, ports)
    if (proc.ppid <= 1) return false
    pid = proc.ppid
  }
  return false
}

/**
 * A positive check, since no denylist of relays is complete: the session's own pid must
 * be Claude Code itself, by its executable or by a runtime running the Claude Code package.
 */
const runsClaudeCode = (pid: number, ports: PeerPorts): boolean => {
  const [exe, entry] = ports.argv(pid)?.trim().split(/\s+/) ?? []
  if (exe === undefined) return false
  if (path.basename(exe) === 'claude') return true
  return ['node', 'bun'].includes(path.basename(exe)) && (entry?.includes('/claude-code/') ?? false)
}

/**
 * CC-1206: the first pid running Claude Code in the peer's ancestry, the peer included, or
 * undefined when none is found within `maxDepth`. A hit only lowers trust (an agent, not
 * the human, is behind the connection), so unlike `provePeerLocal` it does not stop at a
 * socket forwarder: walking past one cannot grant anything. Real defense in depth, not a fix: a caller detached from its own tree
 * (`setsid`, `nohup … &`, `tmux new -d`, `systemd-run --user`) or a raw socket write from
 * such a process has no Claude Code ancestor and is not caught here.
 */
export function claudeCodeAncestor(conn: net.Socket, ports: PeerPorts, maxDepth = 64): number | undefined {
  return claudeCodeAncestorOf(ports.peerPid(conn), ports, maxDepth)
}

/** `claudeCodeAncestor` from a pid already read, so one spawn reads its peer once. */
export function claudeCodeAncestorOf(
  start: number | undefined,
  ports: PeerPorts,
  maxDepth = 64,
): number | undefined {
  const seen = new Set<number>()
  let pid = start
  while (pid !== undefined && pid > 1 && seen.size < maxDepth && !seen.has(pid)) {
    if (runsClaudeCode(pid, ports)) return pid
    seen.add(pid)
    pid = ports.process(pid)?.ppid
  }
  return undefined
}

/**
 * CC-1246: why the peer `pid` is not proven to be the human at a terminal, or undefined when it is.
 * Proof is positive: a readable peer pid with a controlling tty, a strict descendant of its own
 * session leader, which is an interactive process (no `-c` script) with no Claude Code ancestor.
 * So a missing peer pid (off Linux, a forwarded socket), `setsid` or `systemd-run` (no tty), an
 * orphan reparented away from its session (`nohup … &`) and `tmux new -d '<cmd>'` (the command
 * leads its session, or a `sh -c` does) all fail. Not closed: an agent typing into an
 * interactive shell it owns, e.g. `tmux send-keys`, looks the same as the human to the kernel.
 */
export function humanProofGap(pid: number | undefined, ports: PeerPorts): string | undefined {
  if (pid === undefined) return 'no peer pid'
  const term = ports.terminal(pid)
  if (term === undefined) return 'peer terminal unreadable'
  if (term.ttyNr === 0) return 'no controlling tty'
  if (!descendsFrom(pid, term.session, ports)) return 'not under its session leader'
  if (runsScript(ports.argv(term.session))) return 'session leader runs a script'
  const agent = claudeCodeAncestorOf(term.session, ports)
  return agent === undefined ? undefined : `session leader under Claude Code ${agent}`
}

/** A strict descendant: the peer leading its own session (`setsid cmd`, `tmux new -d cmd`) is not. */
const descendsFrom = (pid: number, leader: number, ports: PeerPorts): boolean => {
  if (leader <= 1) return false
  let current: number | undefined = ports.process(pid)?.ppid
  for (let depth = 0; current !== undefined && current > 1 && depth < 64; depth++) {
    if (current === leader) return true
    current = ports.process(current)?.ppid
  }
  return false
}

/** An unreadable command line, or one with a short-flag cluster holding `c` (`sh -c`, `bash -lc`). */
const runsScript = (argv: string | undefined): boolean =>
  argv === undefined ||
  argv
    .trim()
    .split(/\s+/)
    .slice(1)
    .some(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token))

const forwarderAt = (pid: number, ports: PeerPorts): boolean => {
  const proc = ports.process(pid)
  return proc === undefined || FORWARDERS.test(proc.comm)
}

/** `pid (comm) S ppid ...`; comm may itself contain parentheses, so cut at the last one. */
export function parseStat(stat: string): { ppid: number; comm: string } | undefined {
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (open < 0 || close < open) return undefined
  const ppid = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  )
  return Number.isInteger(ppid) ? { ppid, comm: stat.slice(open + 1, close) } : undefined
}

/** CC-1246: `session` and `tty_nr`, the 4th and 5th fields after comm (`state ppid pgrp session tty_nr`). */
export function parseStatTerminal(stat: string): { session: number; ttyNr: number } | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const [session, ttyNr] = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
    .slice(3, 5)
    .map(Number)
  return Number.isInteger(session) && Number.isInteger(ttyNr)
    ? { session: session!, ttyNr: ttyNr! }
    : undefined
}

const readStat = (pid: number): string | undefined => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The pid owning the peer end of the socket whose inode is `inode`, from `ss -xnpH`
 * output. Undefined unless exactly one process holds the peer end.
 */
export function peerPidFromSs(output: string, inode: string): number | undefined {
  const rows = output
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 8)
  const mine = rows.find(cols => cols[5] === inode)
  const peerInode = mine?.[7]
  if (peerInode === undefined || peerInode === '0') return undefined
  const theirs = rows.find(cols => cols[5] === peerInode)
  const pids = [
    ...(theirs
      ?.slice(8)
      .join(' ')
      .matchAll(/pid=(\d+)/g) ?? []),
  ].map(m => Number(m[1]))
  return new Set(pids).size === 1 ? pids[0] : undefined
}

function socketInode(conn: net.Socket): string | undefined {
  const fd = (conn as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (typeof fd !== 'number' || fd < 0) return undefined
  try {
    return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${fd}`))?.[1]
  } catch {
    return undefined
  }
}

/** One dump of every unix socket with its holders; throws when `ss` fails or outruns its cap. */
export const defaultSs = (): string =>
  execFileSync('ss', ['-xnpH'], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 << 20 })

/**
 * Linux only: elsewhere there is no peer pid to read, so every session stays remote.
 * `runSs` is injectable so a test can see why a real read came back empty (CC-1164).
 */
export const linuxPeerPortsWith = (runSs: () => string): PeerPorts => ({
  peerPid(conn) {
    if (process.platform !== 'linux') return undefined
    const inode = socketInode(conn)
    if (inode === undefined) return undefined
    try {
      return peerPidFromSs(runSs(), inode)
    } catch {
      return undefined
    }
  },
  argv: psArgvReader,
  process(pid) {
    const stat = readStat(pid)
    return stat === undefined ? undefined : parseStat(stat)
  },
  // Off Linux there is no /proc, so this reads undefined and a human stays unproven (fail closed).
  terminal(pid) {
    const stat = readStat(pid)
    return stat === undefined ? undefined : parseStatTerminal(stat)
  },
})

export const linuxPeerPorts: PeerPorts = linuxPeerPortsWith(defaultSs)
