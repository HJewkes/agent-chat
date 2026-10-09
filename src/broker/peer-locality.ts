import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import type net from 'node:net'

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
  process(pid: number): { ppid: number; comm: string } | undefined
}

/** The MCP server sits at most a wrapper or two below Claude Code; a longer chain is not that shape. */
const MAX_DEPTH = 4

/** Whatever holds the broker's end of a forwarded socket: sshd for an inbound one, the ssh client for `ssh -R`. */
const FORWARDERS = /^(sshd|ssh|autossh|socat)/

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
    if (proc.ppid === hostPid) return !forwarderAt(hostPid, ports)
    if (proc.ppid <= 1) return false
    pid = proc.ppid
  }
  return false
}

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

/** Linux only: elsewhere there is no peer pid to read, so every session stays remote. */
export const linuxPeerPorts: PeerPorts = {
  peerPid(conn) {
    if (process.platform !== 'linux') return undefined
    const inode = socketInode(conn)
    if (inode === undefined) return undefined
    try {
      const out = execFileSync('ss', ['-xnpH'], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 << 20 })
      return peerPidFromSs(out, inode)
    } catch {
      return undefined
    }
  },
  process(pid) {
    try {
      return parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return undefined
    }
  },
}
