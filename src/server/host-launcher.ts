import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { clearSuperseded, markSuperseded, OFF_BROKER, writeLaunchFiles } from '../agents/launch-files.js'
import { surfaceFor } from '../agents/launcher.js'
import { SENSITIVE_DIRS } from '../agents/spawn-cwd.js'
import { findTranscript } from '../agents/transcript.js'
import { launcherTrustRefusal } from '../agents/trust.js'
import { surfaceBlockerFor } from '../agents/surface-resolution.js'
import type { LaunchPlan } from '../agents/types.js'
import type { HostAnswer } from '../broker/host-directory.js'
import { LAUNCH_TIMEOUT_MS } from '../broker/host-directory.js'
import { helloProof, ownKey } from '../broker/launcher-key.js'
import { cliEntry } from '../paths.js'
import {
  encode,
  lineReader,
  SURFACE_NAMES,
  type ClientMessage,
  type HostProbe,
  type HostProbeMissing,
  type RemoteLaunch,
  type ServerMessage,
  type SurfaceName,
} from '../protocol.js'
import { buildCallerLaunch, type LocalHost } from './caller-teleport.js'
import {
  checkLaunch,
  defaultSpawnHost,
  isSessionId,
  placeRemoteSpawn,
  prepareRemoteSpawn,
  type SpawnHost,
} from './remote-launch.js'

/**
 * CC-951 g2: the machine side of a host launcher. It holds a connection of its own to the broker,
 * announces its machine with `host_hello`, answers `host_probe` about its own disk, and launches
 * a teleport successor from a `host_launch` spec and a spawn from a `host_spawn` one (CC-1062). Every check that matters is made here, on this
 * machine: the broker checked the paths only lexically, so they are resolved through realpath
 * and checked again before anything is written or opened.
 *
 * An answer the broker never gets (the connection dropped, or the launch outran the broker's
 * window) leaves the broker retiring the successor's row while its process may still start.
 * That process is marked superseded here, so its prompts are blocked, and the broker refuses a
 * retired identity's registration, so it never holds the name.
 */

export interface LauncherIdentity {
  host: string
  platform: NodeJS.Platform
  surfaces: SurfaceName[]
  /** CC-1646: the dir a successor lands in when its own cwd is missing here; announced only if usable. */
  landing?: string
}

export interface LauncherDeps {
  homeDir: string
  cliEntry: string
  env: NodeJS.ProcessEnv
  writeFiles(plan: LaunchPlan, mcpConfig: Record<string, unknown>): void
  launch(surface: SurfaceName, plan: LaunchPlan): Promise<void>
  markSuperseded(agentId: string): void
  clearSuperseded(agentId: string): void
  /** CC-1063: this machine's launcher key, read from its 0600 file on every connect, never from env. */
  readKey(): string | null
  /** CC-1062: the shared executor's view of this machine, for a `host_spawn`. */
  spawnHost: SpawnHost
}

/** Answered before the broker's own launch window closes, so an answer is not lost to its timeout. */
export const LAUNCH_BUDGET_MS = LAUNCH_TIMEOUT_MS - 15_000

/** The surfaces this machine can open: iTerm2 only on macOS, tmux only where it is installed. */
export function hostSurfaces(platform: NodeJS.Platform, hasTmux: boolean): SurfaceName[] {
  return SURFACE_NAMES.filter(surface => {
    if (surface === 'tmux-window' && !hasTmux) return false
    return surfaceBlockerFor(surface, platform) === undefined
  })
}

const realDir = (dir: string): string | undefined => {
  try {
    return fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : undefined
  } catch {
    return undefined
  }
}

/** The real path, or why it cannot be used here: missing, under a credential directory, or not under home. */
export function localPath(
  label: string,
  dir: string,
  homeDir: string,
): { real: string } | { reason: string } {
  const real = realDir(dir)
  if (real === undefined) return { reason: `its ${label} ${dir} is not a directory on this machine` }
  // Lowercased always: on a case-insensitive disk `.SSH` is `.ssh`, and refusing both fails closed.
  const segments = real.toLowerCase().split(path.sep)
  const sensitive = SENSITIVE_DIRS.find(name => segments.includes(name.toLowerCase()))
  if (sensitive !== undefined)
    return { reason: `its ${label} ${dir} resolves inside a protected directory ("${sensitive}")` }
  const home = realDir(homeDir) ?? homeDir
  if (!real.startsWith(home + path.sep))
    return { reason: `its ${label} ${dir} resolves outside the home directory ${home}` }
  return { real }
}

function surfaceReason(surface: SurfaceName, identity: LauncherIdentity): string | undefined {
  if (!identity.surfaces.includes(surface))
    return `the launcher on ${identity.host} cannot open a ${surface} surface`
  return surfaceBlockerFor(surface, identity.platform)
}

interface LocalPaths {
  cwd: string
  configDir?: string
}

function resolveDirs(
  paths: { cwd: string; configDir?: string | undefined },
  homeDir: string,
): LocalPaths | string {
  const cwd = localPath('cwd', paths.cwd, homeDir)
  if ('reason' in cwd) return cwd.reason
  if (paths.configDir === undefined) return { cwd: cwd.real }
  const configDir = localPath('config dir', paths.configDir, homeDir)
  if ('reason' in configDir) return configDir.reason
  return { cwd: cwd.real, configDir: configDir.real }
}

/** CC-1081: a successor in an untrusted cwd sits on the trust prompt with nobody to answer it. */
function resolvePaths(
  paths: { cwd: string; configDir?: string | undefined },
  homeDir: string,
): LocalPaths | string {
  const local = resolveDirs(paths, homeDir)
  if (typeof local === 'string') return local
  return launcherTrustRefusal(local.cwd, local.configDir) ?? local
}

const refused = (reason: string): HostAnswer => ({ ok: false, reason })

type TranscriptVerdict = NonNullable<HostAnswer['transcript']>

/**
 * CC-1472: the session's transcript under the account it ran on. An account the spec leaves unset
 * is this machine's default one, never the launcher's own `CLAUDE_CONFIG_DIR`.
 */
function transcriptVerdict(paths: LocalPaths, sessionId: string, homeDir: string): TranscriptVerdict {
  const found = findTranscript(paths.cwd, sessionId, paths.configDir ?? path.join(homeDir, '.claude'))
  return { path: found.path, found: found.exists }
}

function transcriptRefusal(verdict: TranscriptVerdict, sessionId: string, host: string): string {
  return `the transcript of session ${sessionId} is not on ${host} at ${verdict.path}`
}

function resumeAnswer(paths: LocalPaths, sessionId: string, host: string, homeDir: string): HostAnswer {
  if (!isSessionId(sessionId))
    return refused(`the session to resume ${JSON.stringify(sessionId)} is not a uuid`)
  const transcript = transcriptVerdict(paths, sessionId, homeDir)
  if (transcript.found) return { ok: true, transcript }
  return { ok: false, reason: transcriptRefusal(transcript, sessionId, host), transcript }
}

/** CC-1646: the probed path that is not here at all, as against one refused for where it resolves. */
function missingPath(probe: HostProbe): HostProbeMissing | undefined {
  if (realDir(probe.cwd) === undefined) return 'cwd'
  if (probe.configDir !== undefined && realDir(probe.configDir) === undefined) return 'configDir'
  return undefined
}

export function answerProbe(probe: HostProbe, identity: LauncherIdentity, deps: LauncherDeps): HostAnswer {
  const surface = surfaceReason(probe.surface, identity)
  if (surface !== undefined) return refused(surface)
  const paths = resolvePaths(probe, deps.homeDir)
  if (typeof paths === 'string') {
    const missing = missingPath(probe)
    return missing === undefined ? refused(paths) : { ...refused(paths), missing }
  }
  if (probe.resumeSession === undefined) return { ok: true }
  return resumeAnswer(paths, probe.resumeSession, identity.host, deps.homeDir)
}

/** This machine's env with the predecessor's account, or none when it ran on the default one. */
function hostFor(paths: LocalPaths, deps: LauncherDeps): LocalHost {
  const { CLAUDE_CONFIG_DIR: _own, ...env } = deps.env
  return {
    cliEntry: deps.cliEntry,
    cwd: paths.cwd,
    env: paths.configDir === undefined ? env : { ...env, CLAUDE_CONFIG_DIR: paths.configDir },
  }
}

function launchReason(
  spec: RemoteLaunch,
  identity: LauncherIdentity,
  deps: LauncherDeps,
): LocalPaths | string {
  const bad = checkLaunch(spec)
  if (bad !== undefined) return bad
  if (spec.cwd === undefined) return 'the launch names no cwd'
  return (
    surfaceReason(spec.surface, identity) ??
    resolvePaths({ cwd: spec.cwd, configDir: spec.configDir }, deps.homeDir)
  )
}

const timedOut = Symbol('timed out')

function within<T>(work: Promise<T>, ms: number): Promise<T | typeof timedOut> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => resolve(timedOut), ms)
  })
  work.catch(() => undefined)
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Never the predecessor's pane: a successor launched here opens a new surface on this machine. */
export async function answerLaunch(
  spec: RemoteLaunch,
  identity: LauncherIdentity,
  deps: LauncherDeps,
  budgetMs = LAUNCH_BUDGET_MS,
): Promise<HostAnswer> {
  const paths = launchReason(spec, identity, deps)
  if (typeof paths === 'string') return refused(paths)
  try {
    const { plan, mcpConfig } = buildCallerLaunch(spec, hostFor(paths, deps))
    deps.writeFiles(plan, mcpConfig)
    if ((await within(deps.launch(spec.surface, plan), budgetMs)) !== timedOut) return { ok: true }
  } catch (err) {
    return refused((err as Error).message)
  }
  deps.markSuperseded(spec.agentId)
  return refused(`the ${spec.surface} surface did not open within ${budgetMs / 1000}s`)
}

/** CC-1062: why a spawn cannot run here, checked before the shared executor writes anything. */
function spawnReason(spec: RemoteLaunch, identity: LauncherIdentity, homeDir: string): string | undefined {
  if (spec.cwd === undefined) return 'the launch names no cwd'
  const blocked = surfaceReason(spec.surface, identity)
  if (blocked !== undefined) return blocked
  const paths = resolvePaths({ cwd: spec.cwd, configDir: spec.configDir }, homeDir)
  if (typeof paths === 'string') return paths
  // CC-1472: checked again, since the transcript can go between the broker's probe and this launch.
  return spec.resume === true ? resumeAnswer(paths, spec.sessionId, identity.host, homeDir).reason : undefined
}

/**
 * CC-1062: a spawn routed here by the broker, run by the same executor a caller-site spawn uses,
 * so its env and MCP servers come from this machine's profile. It opens without waiting for an
 * ack: the broker holds its identity while this request is outstanding.
 */
export async function answerSpawn(
  spec: RemoteLaunch,
  identity: LauncherIdentity,
  deps: LauncherDeps,
  budgetMs = LAUNCH_BUDGET_MS,
): Promise<HostAnswer> {
  const reason = spawnReason(spec, identity, deps.homeDir)
  if (reason !== undefined) return refused(reason)
  const prepared = prepareRemoteSpawn(spec, deps.spawnHost)
  if (!prepared.ok) return refused(prepared.reason)
  // CC-1472: a resume reuses the agent's permanent id, which an earlier timed-out resume here marked.
  // Cleared only once the spec passed every check and its plan is written, so a refusal grants nothing.
  if (spec.resume === true) deps.clearSuperseded(spec.agentId)
  const failed = await within(placeRemoteSpawn(spec, prepared.plan, deps.spawnHost), budgetMs)
  if (failed === timedOut) {
    deps.markSuperseded(spec.agentId)
    return refused(`the ${spec.surface} surface did not open within ${budgetMs / 1000}s`)
  }
  if (failed === undefined) return { ok: true }
  deps.spawnHost.discard(spec.agentId)
  return refused(failed)
}

/** The launcher's end of its broker connection. */
export interface LauncherLink {
  send(frame: ClientMessage): void
  isOpen(): boolean
}

/**
 * Answers one broker request. A launch whose answer can no longer reach the broker is marked
 * superseded, since the broker released its successor when the connection went.
 */
export async function handleHostFrame(
  frame: ServerMessage,
  identity: LauncherIdentity,
  deps: LauncherDeps,
  link: LauncherLink,
): Promise<void> {
  if (frame.t === 'host_probe') {
    const answer = answerProbe(frame.probe, identity, deps)
    return link.send({ t: 'host_probe_result', id: frame.id, ...answer })
  }
  if (frame.t !== 'host_launch' && frame.t !== 'host_spawn') return
  const answer =
    frame.t === 'host_spawn'
      ? await answerSpawn(frame.launch, identity, deps)
      : await answerLaunch(frame.launch, identity, deps)
  if (answer.ok && !link.isOpen()) return deps.markSuperseded(frame.launch.agentId)
  link.send({ t: 'host_launch_result', id: frame.id, ...answer })
}

export const defaultLauncherDeps = (homeDir: string): LauncherDeps => ({
  homeDir,
  cliEntry: cliEntry(),
  env: process.env,
  writeFiles: (plan, mcpConfig) => void writeLaunchFiles(plan, mcpConfig, undefined, OFF_BROKER),
  launch: async (surface, plan) => void (await surfaceFor(surface).launch(plan)),
  markSuperseded,
  clearSuperseded,
  readKey: ownKey,
  spawnHost: { ...defaultSpawnHost(), homeDir },
})

type Log = (line: string) => void

/** A broker older than CC-1063 ignores `host_challenge`; give up rather than wait forever. */
export const CHALLENGE_TIMEOUT_MS = 10_000

/**
 * CC-1646: the landing dir by its real path, checked on every connect so one made after the launcher
 * started is announced on its next connect; one missing, outside home or under a credential dir is not.
 */
export function announcedLanding(identity: LauncherIdentity, homeDir: string): string | undefined {
  if (identity.landing === undefined) return undefined
  const local = localPath('landing dir', identity.landing, homeDir)
  return 'real' in local ? local.real : undefined
}

/** The hello for this nonce, proved with the key on disk now, so a rotated key needs no restart. */
function provedHello(identity: LauncherIdentity, deps: LauncherDeps, nonce: string): ClientMessage {
  const { landing: _requested, ...announced } = identity
  const landing = announcedLanding(identity, deps.homeDir)
  const hello = { t: 'host_hello' as const, ...announced, ...(landing === undefined ? {} : { landing }) }
  const key = deps.readKey()
  if (key === null) return hello
  return { ...hello, proof: helloProof(key, identity.host, nonce) }
}

/**
 * One connection's life: challenge, hello, then answers, until it closes. Resolves with why it
 * ended. With no key file the hello goes without a proof and the broker's refusal says why.
 */
export function serveConnection(
  socket: net.Socket,
  identity: LauncherIdentity,
  deps: LauncherDeps,
  log: Log,
  challengeMs = CHALLENGE_TIMEOUT_MS,
): Promise<string> {
  const link: LauncherLink = {
    send: frame => void socket.write(encode(frame)),
    isOpen: () => !socket.destroyed,
  }
  return new Promise(resolve => {
    const end = (reason: string): void => {
      clearTimeout(challenge)
      socket.destroy()
      resolve(reason)
    }
    const challenge = setTimeout(
      () => end(`the broker did not answer host_challenge within ${challengeMs / 1000}s`),
      challengeMs,
    )
    const onFrame = (frame: ServerMessage): void => {
      if (frame.t === 'host_challenge_result') {
        clearTimeout(challenge)
        return link.send(provedHello(identity, deps, frame.nonce))
      }
      if (frame.t === 'host_hello_result') {
        if (frame.ok) return log(`launching for ${identity.host} (${identity.surfaces.join(', ')})`)
        return end(`the broker refused this launcher: ${frame.reason ?? 'no reason given'}`)
      }
      void handleHostFrame(frame, identity, deps, link).catch(err =>
        log(`request failed: ${(err as Error).message}`),
      )
    }
    socket.on(
      'data',
      lineReader<ServerMessage>(onFrame, err => log(`bad frame: ${err.message}`)),
    )
    socket.once('close', () => end('the broker connection closed'))
    socket.once('error', err => end(`the broker connection failed: ${err.message}`))
    link.send({ t: 'host_challenge' })
  })
}

const RECONNECT_MS = 5_000

const connect = (socketPath: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

/** Never returns: a launcher reconnects after any drop, so a broker restart does not strand it. */
export async function serveHost(
  socketPath: string,
  identity: LauncherIdentity,
  deps: LauncherDeps,
  log: Log,
): Promise<never> {
  for (;;) {
    try {
      log(await serveConnection(await connect(socketPath), identity, deps, log))
    } catch (err) {
      log(`cannot reach the broker at ${socketPath}: ${(err as Error).message}`)
    }
    await new Promise(resolve => setTimeout(resolve, RECONNECT_MS))
  }
}
