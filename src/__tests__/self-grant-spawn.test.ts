import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { loadProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'
import { hookSettingsPath } from '../agents/launch-files.js'
import { linkedWorktreeRoot, REPO_SKILLS_RULE } from '../agents/skill-self-grant.js'
import { transcriptPath } from '../agents/transcript.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-1110: every supervisor launch path arms the repo-skill self-grant only for the
 * tree agent-chat recorded creating, never for a cwd whose `.git` merely looks linked.
 */

const tmpDirs: string[] = []
let home: string
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(): string {
  const dir = tmp('selfgrant-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  git(['commit', '--allow-empty', '-m', 'seed'], dir)
  return dir
}

/** A hand-written common dir whose layout git accepts, made by nothing agent-chat ran. */
function forgedWorktree(): string {
  const base = tmp('selfgrant-forged-')
  const fake = path.join(base, 'fake')
  const admin = path.join(fake, 'worktrees', 'w')
  const cwd = path.join(base, 'cwd')
  for (const dir of [path.join(fake, 'objects'), path.join(fake, 'refs'), admin, cwd])
    fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(fake, 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
  fs.writeFileSync(path.join(admin, 'gitdir'), `${path.join(cwd, '.git')}\n`)
  fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${admin}\n`)
  return cwd
}

function writeProfile(name: string, isolation: 'none' | 'worktree'): void {
  fs.writeFileSync(
    path.join(home, 'profiles', `${name}.json`),
    JSON.stringify({
      description: name,
      model: 'sonnet',
      allowedTools: ['Read', 'Write', 'Edit', REPO_SKILLS_RULE],
      isolation,
      surface: 'headless',
    }),
  )
}

async function spawnIn(
  name: string,
  cwd: string,
  profile: string,
  over: Record<string, unknown> = {},
): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile,
    brief: 'do the task',
    requestedBy: 'human',
    cwd,
    surface: 'headless',
    spawnerConfigDir: tmp('selfgrant-account-'),
    ...over,
  })
  expect(spawned.reason).toBeUndefined()
  const agent = core.agents.get(spawned.agentId as string)!
  const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, '{}\n')
  return agent
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

const hookCommands = (agentId: string): string => fs.readFileSync(hookSettingsPath(agentId), 'utf8')

beforeEach(() => {
  home = tmp('selfgrant-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  writeProfile('skill-writer', 'worktree')
  writeProfile('skill-writer-shared', 'none')
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    cwdLister: async () => [],
    nameFreeMs: 200,
    surface: {
      platform: 'darwin',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: script => Promise.resolve(script.includes('is running') ? 'true' : 'fake-pane-uuid'),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('arming the self-grant from the supervisor (CC-1110)', () => {
  it('gives a worktree-isolated opted-in spawn the self-grant hook on its allocated tree', async () => {
    const agent = await spawnIn('worker-a', makeRepo(), 'skill-writer')

    expect(hookCommands(agent.agentId)).toContain(`--self-grant-skills '${agent.cwd}'`)
  })

  it('gives an isolation:none spawn into a forged common dir no self-grant', async () => {
    const cwd = forgedWorktree()
    expect(linkedWorktreeRoot(cwd)).toBe(cwd)

    const agent = await spawnIn('worker-b', cwd, 'skill-writer-shared')

    expect(agent.cwd).toBe(cwd)
    expect(hookCommands(agent.agentId)).not.toContain('--self-grant-skills')
  })

  it('keeps the self-grant on the tree when a finished agent is resumed', async () => {
    const agent = await spawnIn('worker-c', makeRepo(), 'skill-writer')
    await exit(agent)
    fs.writeFileSync(hookSettingsPath(agent.agentId), '{}')

    const resumed = await sup.resume('worker-c')

    expect(resumed.reason).toBeUndefined()
    expect(hookCommands(agent.agentId)).toContain(`--self-grant-skills '${agent.cwd}'`)
  })

  it('gives no self-grant to an assigned tree swapped for a forged common dir behind an old record', async () => {
    const repo = makeRepo()
    const first = await spawnIn('worker-d', repo, 'skill-writer')
    await exit(first)
    git(['worktree', 'remove', '--force', first.cwd], repo)
    fs.symlinkSync(forgedWorktree(), first.cwd)

    const second = await spawnIn('worker-e', repo, 'skill-writer', { worktree: first.cwd })

    expect(hookCommands(second.agentId)).not.toContain('--self-grant-skills')
  })

  /** A headless plan is the only one with a permission hook, so the switch goes that way. */
  async function backgrounded(name: string, agent: AgentIdentity) {
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === 7777 || kill(pid, signal))
    fs.writeFileSync(hookSettingsPath(agent.agentId), '{}')
    const switched = await sup.switchSurface({
      name,
      to: 'headless',
      requestedBy: name,
      hostPid: 7777,
      host: os.hostname(),
    })
    expect(switched.reason).toBeUndefined()
  }

  it('keeps the self-grant when a live agent switches surface onto its own tree', async () => {
    const agent = await spawnIn('worker-f', makeRepo(), 'skill-writer', { surface: 'iterm-pane' })

    await backgrounded('worker-f', agent)

    expect(hookCommands(agent.agentId)).toContain(`--self-grant-skills '${agent.cwd}'`)
  })

  it('gives no self-grant when a surface switch falls back to the bare cwd', async () => {
    const agent = await spawnIn('worker-g', makeRepo(), 'skill-writer', { surface: 'iterm-pane' })
    await exit(agent)

    await backgrounded('worker-g', agent)

    expect(hookCommands(agent.agentId)).toContain('permission-hook')
    expect(hookCommands(agent.agentId)).not.toContain('--self-grant-skills')
  })

  it("arms a teleport successor on the predecessor's tree it inherits", async () => {
    const agent = await spawnIn('worker-h', makeRepo(), 'skill-writer')
    const inherited = sup.inheritedIsolation(agent.agentId)
    core.append({ kind: 'agent_retired', actor: 'agent-chat', target: 'worker-h', ref: agent.agentId })

    await sup.relaunch({
      agentId: 'ag-succ1',
      name: 'worker-h',
      profile: loadProfile('skill-writer') as AgentProfile,
      brief: 'carry on',
      cwd: agent.cwd,
      surface: 'headless',
      preamble: 'you are the continuation',
      meta: {},
      ...(inherited === undefined ? {} : { inherited }),
      inheritedFrom: agent.agentId,
    })

    expect(inherited).toBeDefined()
    expect(hookCommands('ag-succ1')).toContain(`--self-grant-skills '${agent.cwd}'`)
  })
})
