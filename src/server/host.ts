import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LAUNCHER_PID_ENV } from '../agents/launcher.js'
import { CODEX_SESSION_PREFIX, isCodexSessionId } from '../protocol.js'

/**
 * What this process knows about the Claude Code session it belongs to, without
 * asking the model anything.
 *
 * Both fields answer questions the broker cannot answer for itself and the model
 * must not be trusted to answer for it. They travel on `register`, next to
 * `terminalAnchor()`, for the same structural reason: the broker runs detached
 * and has neither this environment nor this process tree.
 *
 * `CLAUDE_CODE_SESSION_ID` is set in every agent-chat MCP subprocess (verified
 * with `ps eww` across five live subprocesses on 2026-07-28). It is the id
 * `transcript.ts` derives a transcript path from, so recording it makes an
 * ordinary session's transcript findable exactly the way a spawned agent's
 * already is.
 *
 * `process.ppid` is Claude Code itself: every one of those five subprocesses had
 * a parent whose command was `claude`. It is a HANDLE, not a licence — the
 * parent is whatever launched this process, and nothing may signal it without
 * first establishing that killing it is the intended act.
 */
export interface HostIdentity {
  sessionId?: string
  hostPid?: number
}

/**
 * The identity every register frame and session-id reader uses, resolved once
 * here so a Codex host never presents two (CC-1508). `parentComm` is injectable
 * because reading it touches `/proc` or `ps`.
 */
export function hostIdentity(
  env: NodeJS.ProcessEnv = process.env,
  ppid = process.ppid,
  parentComm: (pid: number) => string | undefined = cachedCommOf,
): HostIdentity {
  const { harness: _harness, ...identity } = currentSessionHost(env, ppid, parentComm)
  return identity
}

const environmentIdentity = (env: NodeJS.ProcessEnv, ppid: number): HostIdentity => {
  const sessionId = env.CLAUDE_CODE_SESSION_ID
  return {
    ...(sessionId ? { sessionId } : {}),
    // 1 means this process was reparented to init, so its parent is already gone
    // and the handle would point at something that is not the session.
    ...(Number.isInteger(ppid) && ppid > 1 ? { hostPid: ppid } : {}),
  }
}

/** Which program launched this MCP server; only Claude Code renders a channel push (CC-1508). */
export type Harness = 'claude-code' | 'codex'

/**
 * Codex sets no `CLAUDE_CODE_SESSION_ID` and passes no `CODEX_*` variables to MCP
 * children, so its own process name is the only evidence it leaves. The
 * environment override covers a wrapper sitting between the two.
 */
export function detectHarness(env: NodeJS.ProcessEnv, parentComm: string | undefined): Harness {
  if (env.AGENT_CHAT_HOST === 'codex') return 'codex'
  return parentComm !== undefined && path.basename(parentComm.trim()) === 'codex' ? 'codex' : 'claude-code'
}

export interface SessionHost extends HostIdentity {
  harness: Harness
}

/**
 * The identity a session registers and readopts under.
 *
 * Under Codex any `CLAUDE_CODE_SESSION_ID` was inherited from a Claude Code
 * session that started it, so it is never this session's; the id is minted from
 * the Codex process instead, which every MCP child and hook of it can compute.
 */
export function sessionHost(harness: Harness, identity: HostIdentity, machine: string): SessionHost {
  if (harness === 'claude-code') return { harness, ...identity }
  const { hostPid } = identity
  return hostPid === undefined
    ? { harness }
    : { harness, hostPid, sessionId: `${CODEX_SESSION_PREFIX}${hostPid}@${machine}` }
}

/** `/proc` first, since it costs no process; `ps` for macOS. */
export function commOf(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return psComm(pid)
  }
}

const psComm = (pid: number): string | undefined => {
  for (const ps of PS_CANDIDATES) {
    try {
      const out = execFileSync(ps, ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PS_TIMEOUT_MS,
      }).trim()
      if (out !== '') return out
    } catch {
      continue
    }
  }
  return undefined
}

export function currentSessionHost(
  env: NodeJS.ProcessEnv = process.env,
  ppid = process.ppid,
  parentComm: (pid: number) => string | undefined = cachedCommOf,
): SessionHost {
  const identity = environmentIdentity(env, ppid)
  const comm = identity.hostPid === undefined ? undefined : parentComm(identity.hostPid)
  return sessionHost(detectHarness(env, comm), identity, os.hostname())
}

/** The parent of a live process does not change its name, so one read per pid is enough. */
const commCache = new Map<number, string | undefined>()

const cachedCommOf = (pid: number): string | undefined => {
  if (!commCache.has(pid)) commCache.set(pid, commOf(pid))
  return commCache.get(pid)
}

/** A session id that names a Claude Code transcript, which a Codex id never does. */
export const claudeSessionId = (identity: HostIdentity): string | undefined =>
  identity.sessionId === undefined || isCodexSessionId(identity.sessionId) ? undefined : identity.sessionId

/** The machine this process runs on, sent at registration so the broker never signals a pid from another one (CC-880). */
export function hostMarker(): { host: string } {
  return { host: os.hostname() }
}

export type ParentOf = (pid: number) => number | undefined

/** Absolute, because a launch may carry no usable PATH (CC-132); macOS has only the first. */
const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps']
const PS_TIMEOUT_MS = 2_000

const parentVia = (ps: string, pid: number): number | undefined => {
  try {
    const out = execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
    })
    const ppid = Number.parseInt(out.trim(), 10)
    return Number.isInteger(ppid) ? ppid : undefined
  } catch {
    return undefined
  }
}

export const psParentOf: ParentOf = pid => {
  for (const ps of PS_CANDIDATES) {
    const ppid = parentVia(ps, pid)
    if (ppid !== undefined) return ppid
  }
  return undefined
}

/**
 * Is this server's Claude Code process the one `run-agent` launched, rather than
 * a `claude` started from inside it (CC-174)?
 *
 * The spawn identity rides in the environment, and every process the agent
 * starts inherits it: a nested `claude -p` would otherwise register as its parent
 * and the broker's same-agentId takeover would evict the parent. Only the launched
 * process has `run-agent` as its direct parent. An unanswerable check fails
 * closed, because a lost name is recoverable and a killed parent is not.
 *
 * No launcher pid at all means an older `run-agent`, which is trusted as before.
 */
export function isLaunchedProcess(
  env: NodeJS.ProcessEnv = process.env,
  host: HostIdentity = hostIdentity(env),
  parentOf: ParentOf = psParentOf,
): boolean {
  const launcher = env[LAUNCHER_PID_ENV]
  if (launcher === undefined || launcher === '') return true
  const { hostPid } = host
  if (hostPid === undefined) return false
  return parentOf(hostPid) === Number(launcher)
}
