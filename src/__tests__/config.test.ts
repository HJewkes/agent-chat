import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTICE_TTL_HOURS,
  DEFAULT_PERMISSION_HOOK_TIMEOUT_S,
  resolveAccountRotation,
  resolveAgentSlots,
  resolveCoordinatorGrantableTools,
  resolveCrashLoop,
  resolveContextHintPolicy,
  resolveFullSuiteSlots,
  resolveGitShellAliases,
  resolveMachineLimits,
  resolveMachineStopLimits,
  resolveNoticeTtlMs,
  resolvePermissionHookTimeout,
  resolvePoolProbe,
  resolvePaceControllerMode,
  resolvePoolPickMode,
  resolveProcessGuardMode,
  resolveProcessKillBytes,
  resolveReportBatchMs,
  resolveReviewerWorktreeBudget,
  resolveWorktreeBudget,
  retireThresholdK,
} from '../config.js'
import { newAgentSlots } from '../broker/daemon.js'
import { SPAWN_HEADROOM_LIMITS, STOP_HEADROOM_LIMITS } from './helpers/headroom.js'
import { Semaphore, DEFAULT_SLOTS } from '../agents/semaphore.js'
import { OFF_BROKER, writeLaunchFiles } from '../agents/launch-files.js'
import type { LaunchPlan } from '../agents/types.js'
import { GIT_SHIM_DIR_ENV, gitShimDirFor } from '../leak-guard/git-shim.js'
import { gitHooksEnv } from '../leak-guard/hooks-dir.js'

/**
 * `resolveAgentSlots` is exercised against a real tmp `AGENT_CHAT_HOME`, the
 * same isolation `hooks.test.ts` uses for `hooks.json` — never the real
 * `~/.agent-chat`.
 */

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-config-'))
  process.env.AGENT_CHAT_HOME = dir
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_REPORT_BATCH_SECONDS
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfigJson(config: unknown): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
}

describe('resolveAgentSlots', () => {
  it('keeps DEFAULT_SLOTS when config.json does not exist', () => {
    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })

  it('keeps DEFAULT_SLOTS when agentSlots is absent from an existing config.json', () => {
    writeConfigJson({ worktreeBudget: 8 })

    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })

  it('honors a configured agentSlots value, allowing a 21st acquire at 30', () => {
    writeConfigJson({ agentSlots: 30 })

    const slots = resolveAgentSlots()
    const semaphore = new Semaphore(slots)
    for (let i = 0; i < 20; i++) expect(semaphore.acquire(`agent-${i}`)).toBe(true)

    expect(semaphore.acquire('agent-21')).toBe(true)
    expect(semaphore.summary()).toBe('21/30 slots')
  })

  it.each([
    ['a non-integer', 12.5],
    ['a value below 1', 0],
    ['a non-number', 'thirty'],
  ])('falls back to DEFAULT_SLOTS for %s agentSlots', (_scenario, value) => {
    writeConfigJson({ agentSlots: value })

    expect(resolveAgentSlots()).toBe(DEFAULT_SLOTS)
  })
})

describe('agent slot cap read per spawn (CC-159)', () => {
  it('applies a raised agentSlots to the next acquire without rebuilding the semaphore', () => {
    writeConfigJson({ agentSlots: 2 })
    const semaphore = new Semaphore(resolveAgentSlots)
    semaphore.acquire('a1')
    semaphore.acquire('a2')
    expect(semaphore.acquire('a3')).toBe(false)

    writeConfigJson({ agentSlots: 3 })

    expect(semaphore.acquire('a3')).toBe(true)
    expect(semaphore.summary()).toBe('3/3 slots')
  })

  it('keeps running agents when agentSlots drops below the live count and refuses only new ones', () => {
    writeConfigJson({ agentSlots: 3 })
    const semaphore = new Semaphore(resolveAgentSlots)
    for (const id of ['a1', 'a2', 'a3']) semaphore.acquire(id)

    writeConfigJson({ agentSlots: 1 })

    expect(semaphore.ids()).toEqual(['a1', 'a2', 'a3'])
    expect(semaphore.acquire('a4')).toBe(false)
    expect(semaphore.acquire('a1')).toBe(true)
    expect(semaphore.available).toBe(0)
    semaphore.release('a1')
    semaphore.release('a2')
    expect(semaphore.acquire('a4')).toBe(false)
    semaphore.release('a3')
    expect(semaphore.acquire('a4')).toBe(true)
  })
})

describe("the broker's own slot semaphore (CC-159)", () => {
  it('sees an agentSlots edit made after the broker built it', () => {
    writeConfigJson({ agentSlots: 2 })
    const semaphore = newAgentSlots()
    semaphore.acquire('a1')
    semaphore.acquire('a2')
    expect(semaphore.acquire('a3')).toBe(false)

    writeConfigJson({ agentSlots: 3 })

    expect(semaphore.acquire('a3')).toBe(true)
  })
})

describe('resolveWorktreeBudget', () => {
  it('keeps the fallback when config.json does not exist', () => {
    expect(resolveWorktreeBudget(3)).toBe(3)
  })

  it('returns a positive integer worktreeBudget from config.json', () => {
    writeConfigJson({ worktreeBudget: 10 })

    expect(resolveWorktreeBudget(3)).toBe(10)
  })

  it.each([0, -2, 2.5, '10', null])('falls back when worktreeBudget is %j', value => {
    writeConfigJson({ worktreeBudget: value })

    expect(resolveWorktreeBudget(3)).toBe(3)
  })
})

describe('resolveReviewerWorktreeBudget', () => {
  it('keeps the fallback when config.json does not exist', () => {
    expect(resolveReviewerWorktreeBudget(8)).toBe(8)
  })

  it('returns a positive integer reviewerWorktreeBudget, not worktreeBudget', () => {
    writeConfigJson({ worktreeBudget: 32, reviewerWorktreeBudget: 5 })

    expect(resolveReviewerWorktreeBudget(8)).toBe(5)
  })

  it.each([0, -2, 2.5, '10', null])('falls back when reviewerWorktreeBudget is %j', value => {
    writeConfigJson({ worktreeBudget: 32, reviewerWorktreeBudget: value })

    expect(resolveReviewerWorktreeBudget(8)).toBe(8)
  })
})

describe('machine guard limits (CC-406)', () => {
  it('defaults to 10 headless agents, a 15 percent memory-free floor and 4 full-suite slots', () => {
    expect(resolveMachineLimits()).toEqual({
      headlessAgents: 10,
      memoryFreePercent: 15,
      cpuPressurePercent: 40,
      headroom: SPAWN_HEADROOM_LIMITS,
    })
    expect(resolveFullSuiteSlots()).toBe(4)
  })

  it('reads all three limits from config.json', () => {
    writeConfigJson({ machineHeadlessAgents: 6, machineMemoryFreePercent: 20, fullSuiteSlots: 2 })

    expect(resolveMachineLimits()).toEqual({
      headlessAgents: 6,
      memoryFreePercent: 20,
      cpuPressurePercent: 40,
      headroom: SPAWN_HEADROOM_LIMITS,
    })
    expect(resolveFullSuiteSlots()).toBe(2)
  })

  it.each([0, 101, 50.5, '70'])('falls back to 15 when machineMemoryFreePercent is %j', value => {
    writeConfigJson({ machineMemoryFreePercent: value })

    expect(resolveMachineLimits().memoryFreePercent).toBe(15)
  })

  it('reads machineCpuPressurePercent, and null turns the check off (CC-1670)', () => {
    writeConfigJson({ machineCpuPressurePercent: 55 })
    expect(resolveMachineLimits().cpuPressurePercent).toBe(55)

    writeConfigJson({ machineCpuPressurePercent: null })
    expect(resolveMachineLimits().cpuPressurePercent).toBeNull()
  })

  it.each([0, 101, '40'])('falls back to 40 when machineCpuPressurePercent is %j', value => {
    writeConfigJson({ machineCpuPressurePercent: value })

    expect(resolveMachineLimits().cpuPressurePercent).toBe(40)
  })

  it('reads the three headroom keys, and null disables one (CC-1265)', () => {
    writeConfigJson({
      machineTmpInodesPercent: 60,
      machineTmpBytesPercent: null,
      machineDiskBytesPercent: 95,
    })

    expect(resolveMachineLimits().headroom).toEqual({
      tmp_inodes: { percent: 60, configKey: 'machineTmpInodesPercent' },
      tmp_bytes: { percent: null, configKey: 'machineTmpBytesPercent' },
      disk_bytes: { percent: 95, configKey: 'machineDiskBytesPercent' },
    })
  })

  it.each([0, 101, '70'])('falls back to the default when machineTmpInodesPercent is %j', value => {
    writeConfigJson({ machineTmpInodesPercent: value })

    expect(resolveMachineLimits().headroom.tmp_inodes.percent).toBe(70)
  })
})

describe('machine stop limits (CC-1670)', () => {
  it('defaults CPU pressure to 40 with load5 kept as a backstop', () => {
    expect(resolveMachineStopLimits()).toMatchObject({ cpuPressurePercent: 40, load5: 28 })
  })

  it('reads machineStopCpuPressurePercent and a null load5 that turns the backstop off', () => {
    writeConfigJson({ machineStopCpuPressurePercent: 60, machineStopLoad5: null })

    expect(resolveMachineStopLimits()).toMatchObject({ cpuPressurePercent: 60, load5: null })
  })

  it('a null machineStopCpuPressurePercent disables the CPU trigger', () => {
    writeConfigJson({ machineStopCpuPressurePercent: null })

    expect(resolveMachineStopLimits().cpuPressurePercent).toBeNull()
  })
})

describe('machine stop headroom limits (CC-1265)', () => {
  it('defaults to 80% /tmp inodes and 95% /tmp and disk bytes', () => {
    expect(resolveMachineStopLimits().headroom).toEqual(STOP_HEADROOM_LIMITS)
  })

  it('reads the three stop keys, and null disables one', () => {
    writeConfigJson({
      machineStopTmpInodesPercent: 75,
      machineStopTmpBytesPercent: null,
      machineStopDiskBytesPercent: 98,
    })

    expect(resolveMachineStopLimits().headroom).toEqual({
      tmp_inodes: { percent: 75, configKey: 'machineStopTmpInodesPercent' },
      tmp_bytes: { percent: null, configKey: 'machineStopTmpBytesPercent' },
      disk_bytes: { percent: 98, configKey: 'machineStopDiskBytesPercent' },
    })
  })

  it.each([0, 101, '80'])('falls back to 80 when machineStopTmpInodesPercent is %j', value => {
    writeConfigJson({ machineStopTmpInodesPercent: value })

    expect(resolveMachineStopLimits().headroom.tmp_inodes.percent).toBe(80)
  })
})

describe('resolveContextHintPolicy', () => {
  it('uses the owner-chosen defaults per role when config.json is silent', () => {
    expect(resolveContextHintPolicy('implementer')?.tokens).toBe(200_000)
    expect(resolveContextHintPolicy('implementer-lite')?.tokens).toBe(200_000)
    expect(resolveContextHintPolicy('peer')).toEqual({ tokens: 250_000, boundary: 'assignment boundary' })
  })

  it('gives a session with no profile the configurable default, phrased at an episode boundary', () => {
    expect(resolveContextHintPolicy(undefined)).toEqual({ tokens: 250_000, boundary: 'episode boundary' })
  })

  it.each(['researcher', 'explorer', 'bd-researcher'])('never hints the %s profile', profile => {
    expect(resolveContextHintPolicy(profile)).toBeNull()
  })

  it('hints a reviewer at 300k at its verdict and a planner at 250k at a plan section', () => {
    expect(resolveContextHintPolicy('reviewer')).toEqual({ tokens: 300_000, boundary: 'verdict' })
    expect(resolveContextHintPolicy('planner')).toEqual({ tokens: 250_000, boundary: 'plan section' })
  })

  it('holds a bd-implementer to the implementer 200k rather than the 250k default', () => {
    expect(resolveContextHintPolicy('bd-implementer')).toEqual({
      tokens: 200_000,
      boundary: 'natural stopping point',
    })
  })

  it('holds a bd-reviewer to 300k and a bd-planner to 250k by their role', () => {
    expect(resolveContextHintPolicy('bd-reviewer')?.boundary).toBe('verdict')
    expect(resolveContextHintPolicy('fable-reviewer')?.tokens).toBe(300_000)
    expect(resolveContextHintPolicy('bd-planner')?.boundary).toBe('plan section')
  })

  it('gives bd-implementer-lite the longest matching key, implementer-lite', () => {
    writeConfigJson({ contextHints: { profiles: { 'implementer-lite': { tokens: 150_000 } } } })

    expect(resolveContextHintPolicy('bd-implementer-lite')?.tokens).toBe(150_000)
    expect(resolveContextHintPolicy('bd-implementer')?.tokens).toBe(200_000)
  })

  it('applies a config.json override of a role to the profiles that fall back to it', () => {
    writeConfigJson({ contextHints: { profiles: { reviewer: { tokens: 250_000 } } } })

    expect(resolveContextHintPolicy('bd-reviewer')).toEqual({ tokens: 250_000, boundary: 'verdict' })
  })

  it('lets an exact config.json entry beat the role fallback', () => {
    writeConfigJson({ contextHints: { profiles: { 'bd-implementer': { tokens: 120_000 } } } })

    expect(resolveContextHintPolicy('bd-implementer')?.tokens).toBe(120_000)
    expect(resolveContextHintPolicy('relay-implementer')?.tokens).toBe(200_000)
  })

  it('gives an unlisted profile the default', () => {
    expect(resolveContextHintPolicy('fable-architect')?.tokens).toBe(250_000)
  })

  it('lets config.json move a role threshold, add a role, and silence one', () => {
    writeConfigJson({
      contextHints: {
        default: { tokens: 300_000 },
        profiles: {
          implementer: { tokens: 180_000 },
          designer: { tokens: 200_000, boundary: 'round boundary' },
          peer: null,
        },
      },
    })

    expect(resolveContextHintPolicy('implementer')).toEqual({
      tokens: 180_000,
      boundary: 'natural stopping point',
    })
    expect(resolveContextHintPolicy('designer')).toEqual({ tokens: 200_000, boundary: 'round boundary' })
    expect(resolveContextHintPolicy('peer')).toBeNull()
    expect(resolveContextHintPolicy(undefined)).toEqual({ tokens: 300_000, boundary: 'episode boundary' })
  })

  it('falls back to the built-in value for a malformed entry', () => {
    writeConfigJson({ contextHints: { profiles: { implementer: { tokens: '200k' } } } })

    expect(resolveContextHintPolicy('implementer')?.tokens).toBe(200_000)
  })
})

describe('retireThresholdK', () => {
  it.each([
    ['bd-implementer', 200],
    ['bd-reviewer', 300],
    ['bd-planner', 250],
  ])('retires a %s past %ik', (profile, k) => {
    expect(retireThresholdK(profile)).toBe(k)
  })

  it('follows a config.json move of a role threshold', () => {
    writeConfigJson({ contextHints: { profiles: { implementer: { tokens: 180_000 } } } })

    expect(retireThresholdK('bd-implementer')).toBe(180)
  })

  it('has no threshold for a profile naming no role, even though it is hinted', () => {
    expect(resolveContextHintPolicy('coordinator')?.tokens).toBe(250_000)
    expect(retireThresholdK('coordinator')).toBeUndefined()
  })

  it('has no threshold for a role that config.json silences', () => {
    writeConfigJson({ contextHints: { profiles: { planner: null } } })

    expect(retireThresholdK('bd-planner')).toBeUndefined()
  })
})

describe('resolvePermissionHookTimeout', () => {
  it('defaults to thirty minutes, long enough to answer from a phone', () => {
    expect(resolvePermissionHookTimeout()).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_S)
    expect(DEFAULT_PERMISSION_HOOK_TIMEOUT_S).toBe(1800)
  })

  it('reads permissionHookTimeoutSeconds from config.json', () => {
    writeConfigJson({ permissionHookTimeoutSeconds: 600 })

    expect(resolvePermissionHookTimeout()).toBe(600)
  })

  it('falls back to the default on a value that is not a positive integer', () => {
    writeConfigJson({ permissionHookTimeoutSeconds: 'soon' })

    expect(resolvePermissionHookTimeout()).toBe(DEFAULT_PERMISSION_HOOK_TIMEOUT_S)
  })
})

describe('resolveNoticeTtlMs', () => {
  it('defaults to three days, so a weekend away does not lose a notice', () => {
    expect(DEFAULT_NOTICE_TTL_HOURS).toBe(72)
    expect(resolveNoticeTtlMs()).toBe(72 * 3_600_000)
  })

  it('reads noticeTtlHours from config.json', () => {
    writeConfigJson({ noticeTtlHours: 6 })

    expect(resolveNoticeTtlMs()).toBe(6 * 3_600_000)
  })

  it('falls back to the default on a value that is not a positive integer', () => {
    writeConfigJson({ noticeTtlHours: 0 })

    expect(resolveNoticeTtlMs()).toBe(DEFAULT_NOTICE_TTL_HOURS * 3_600_000)
  })
})

describe('resolveReportBatchMs', () => {
  it('defaults to a 20 second window', () => {
    expect(resolveReportBatchMs()).toBe(20_000)
  })

  it('reads reportBatchSeconds from config.json, where 0 turns batching off', () => {
    writeConfigJson({ reportBatchSeconds: 5 })
    expect(resolveReportBatchMs()).toBe(5_000)

    writeConfigJson({ reportBatchSeconds: 0 })
    expect(resolveReportBatchMs()).toBe(0)
  })

  it('lets AGENT_CHAT_REPORT_BATCH_SECONDS override the file', () => {
    writeConfigJson({ reportBatchSeconds: 5 })
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = '0'

    expect(resolveReportBatchMs()).toBe(0)
  })

  it.each(['soon', '-1', '301'])('falls back to the file value when the override is %s', override => {
    writeConfigJson({ reportBatchSeconds: 5 })
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = override

    expect(resolveReportBatchMs()).toBe(5_000)
  })

  it('falls back to the default when the override is bad and the file sets nothing', () => {
    process.env.AGENT_CHAT_REPORT_BATCH_SECONDS = 'soon'

    expect(resolveReportBatchMs()).toBe(20_000)
  })

  it.each([-1, 1.5, 301, 'soon'])(
    'falls back to the default on %s, which would stall a coordinator',
    value => {
      writeConfigJson({ reportBatchSeconds: value })

      expect(resolveReportBatchMs()).toBe(20_000)
    },
  )
})

describe('resolveCoordinatorGrantableTools', () => {
  it('defaults to the two web-read tools', () => {
    expect(resolveCoordinatorGrantableTools()).toEqual(['WebSearch', 'WebFetch'])
  })

  it('keeps a narrowed list', () => {
    writeConfigJson({ coordinatorGrantableTools: ['WebSearch'] })
    expect(resolveCoordinatorGrantableTools()).toEqual(['WebSearch'])
  })

  it('drops a wildcard and any tool outside the web-read set', () => {
    writeConfigJson({ coordinatorGrantableTools: ['*', 'Bash', 'Monitor', 'WebFetch'] })
    expect(resolveCoordinatorGrantableTools()).toEqual(['WebFetch'])
  })

  it('grants nothing for a value that is not a list', () => {
    writeConfigJson({ coordinatorGrantableTools: 'WebSearch' })
    expect(resolveCoordinatorGrantableTools()).toEqual([])
  })
})

describe('resolvePoolProbe', () => {
  it('is off with no config.json and with no poolProbe key', () => {
    expect(resolvePoolProbe()).toBe(false)
    writeConfigJson({ agentSlots: 30 })

    expect(resolvePoolProbe()).toBe(false)
  })

  it('is on only for poolProbe true', () => {
    writeConfigJson({ poolProbe: true })
    expect(resolvePoolProbe()).toBe(true)

    writeConfigJson({ poolProbe: false })
    expect(resolvePoolProbe()).toBe(false)
  })

  it.each([
    ['a string', 'true'],
    ['a number', 1],
  ])('stays off for %s', (_scenario, value) => {
    writeConfigJson({ poolProbe: value })

    expect(resolvePoolProbe()).toBe(false)
  })
})

describe('resolvePoolPickMode', () => {
  it('is shadow when config.json does not set poolPick', () => {
    writeConfigJson({ agentSlots: 30 })

    expect(resolvePoolPickMode()).toBe('shadow')
  })

  it('honors enforce and off', () => {
    writeConfigJson({ poolPick: 'enforce' })
    expect(resolvePoolPickMode()).toBe('enforce')

    writeConfigJson({ poolPick: 'off' })
    expect(resolvePoolPickMode()).toBe('off')
  })

  it('falls back to shadow on an unknown mode, and logs it', () => {
    writeConfigJson({ poolPick: 'on' })

    expect(resolvePoolPickMode()).toBe('shadow')
    expect(fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')).toContain('"key":"poolPick"')
  })
})

describe('resolvePaceControllerMode (CC-1104)', () => {
  it('is shadow when config.json does not set paceController', () => {
    writeConfigJson({ agentSlots: 30 })

    expect(resolvePaceControllerMode()).toBe('shadow')
  })

  it('honors on and off', () => {
    writeConfigJson({ paceController: 'on' })
    expect(resolvePaceControllerMode()).toBe('on')

    writeConfigJson({ paceController: 'off' })
    expect(resolvePaceControllerMode()).toBe('off')
  })

  it('falls back to shadow on an unknown mode, and logs it', () => {
    writeConfigJson({ paceController: 'bogus' })

    expect(resolvePaceControllerMode()).toBe('shadow')
    expect(fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')).toContain('"key":"paceController"')
  })
})

describe('process guard config (CC-495)', () => {
  it('defaults processGuardMode to log and falls back to log on an unknown value', () => {
    expect(resolveProcessGuardMode()).toBe('log')

    writeConfigJson({ processGuardMode: 'kill' })
    expect(resolveProcessGuardMode()).toBe('kill')

    writeConfigJson({ processGuardMode: 'murder' })
    expect(resolveProcessGuardMode()).toBe('log')
    expect(fs.readFileSync(path.join(dir, 'broker.log'), 'utf8')).toContain('"key":"processGuardMode"')
  })

  it('falls back to 8 GiB when processKillBytes is below 1 GiB', () => {
    expect(resolveProcessKillBytes()).toBe(8 * 1024 ** 3)

    writeConfigJson({ processKillBytes: 16 * 1024 ** 3 })
    expect(resolveProcessKillBytes()).toBe(16 * 1024 ** 3)

    writeConfigJson({ processKillBytes: 8 })
    expect(resolveProcessKillBytes()).toBe(8 * 1024 ** 3)
  })

  it('a bad value read on every guard tick is logged once, and a different bad value again', () => {
    writeConfigJson({ processGuardMode: 'murder', processKillBytes: 8 })
    for (let tick = 0; tick < 5; tick++) {
      resolveProcessGuardMode()
      resolveProcessKillBytes()
    }
    writeConfigJson({ processGuardMode: 'kil', processKillBytes: 8 })
    resolveProcessGuardMode()

    expect(invalidLines()).toEqual([
      expect.stringContaining('"value":"murder"'),
      expect.stringContaining('"value":8'),
      expect.stringContaining('"value":"kil"'),
    ])
  })

  it('malformed config.json read on every guard tick is logged once', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{"processGuardMode": ')
    for (let tick = 0; tick < 5; tick++) resolveProcessGuardMode()

    expect(invalidLines()).toHaveLength(1)
  })
})

describe('gitShellAliases (CC-613)', () => {
  it('lists no shell alias when the key is missing', () => {
    writeConfigJson({ worktreeBudget: 8 })

    expect(resolveGitShellAliases()).toEqual([])
  })

  it('keeps alias names lowercased and drops the rest, logged', () => {
    writeConfigJson({ gitShellAliases: ['p', 'Up', 'bad name', 3] })

    expect(resolveGitShellAliases()).toEqual(['p', 'up'])
    expect(invalidLines()).toEqual([expect.stringContaining('"key":"gitShellAliases"')])
  })

  it('lists nothing for a string value rather than reading it as names', () => {
    writeConfigJson({ gitShellAliases: 'p up' })

    expect(resolveGitShellAliases()).toEqual([])
    expect(invalidLines()).toEqual([expect.stringContaining('"value":"p up"')])
  })

  it('bakes the configured names into the git shim written at spawn', () => {
    writeConfigJson({ gitShellAliases: ['p'] })
    const hooksDir = path.join(dir, 'git-hooks')
    const plan: LaunchPlan = {
      agentId: 'agt-config',
      bin: 'claude',
      args: [],
      cwd: dir,
      env: { ...gitHooksEnv(hooksDir), [GIT_SHIM_DIR_ENV]: gitShimDirFor(hooksDir) },
      title: 'agt-config',
      surface: 'headless',
    }

    writeLaunchFiles(plan, {}, undefined, OFF_BROKER)

    const shim = fs.readFileSync(path.join(gitShimDirFor(hooksDir), 'git'), 'utf8')
    expect(shim).toContain("shell_aliases='p'")
  })
})

function invalidLines(): string[] {
  return fs
    .readFileSync(path.join(dir, 'broker.log'), 'utf8')
    .split('\n')
    .filter(line => line.includes('"config_invalid"'))
}

describe('resolveAccountRotation', () => {
  it('is on with a 90% ceiling and no exclusions when config.json says nothing', () => {
    expect(resolveAccountRotation()).toEqual({ enabled: true, ceilingPct: 90, exclude: [] })
  })

  it('honours each configured field', () => {
    writeConfigJson({ accountRotation: { enabled: false, ceilingPct: 75, exclude: ['personal'] } })

    expect(resolveAccountRotation()).toEqual({ enabled: false, ceilingPct: 75, exclude: ['personal'] })
  })

  it('defaults only the field that is invalid', () => {
    writeConfigJson({ accountRotation: { enabled: 'no', ceilingPct: 140, exclude: ['personal'] } })

    expect(resolveAccountRotation()).toEqual({ enabled: true, ceilingPct: 90, exclude: ['personal'] })
  })
})

describe('crash-loop limits (CC-1671 S4)', () => {
  it('defaults to 30 seconds and 3 launches', () => {
    expect(resolveCrashLoop()).toEqual({ seconds: 30, launches: 3 })
  })

  it('reads both keys, and null turns either off', () => {
    writeConfigJson({ crashLoopSeconds: 45, crashLoopLaunches: null })

    expect(resolveCrashLoop()).toEqual({ seconds: 45, launches: null })
  })

  it('falls back on a value that is not a positive whole number', () => {
    writeConfigJson({ crashLoopSeconds: 0, crashLoopLaunches: 'three' })

    expect(resolveCrashLoop()).toEqual({ seconds: 30, launches: 3 })
  })
})
