import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { BUILTIN_PROFILES, parseProfile } from '../agents/profiles.js'
import { carriesContract, contractOf, readContract, withReturnContract } from '../agents/return-contract.js'
import { transcriptPath } from '../agents/transcript.js'
import { RETURN_CONTRACTS, type AgentProfile, type ReturnContract } from '../agents/types.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-286. The broker appends the return contract that fits the profile, once,
 * with the spawner's name in it. The spawn tests read what the launched process
 * is actually handed; the contract file is the repo's own.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const WRITER = { model: 'opus', allowedTools: ['Read', 'Write', 'Edit', 'Bash'], isolation: 'none' }
const READER = { model: 'opus', allowedTools: ['Read', 'Bash'], disallowedTools: ['Write', 'Edit'] }

/** Profile files as a user would have installed them: none carries a `returnContract` field. */
const USER_PROFILES: Record<string, Record<string, unknown>> = {
  'zz-implementer': WRITER,
  'zz-implementer-lite': WRITER,
  'zz-reviewer': { ...READER, isolation: 'none' },
  researcher: { ...READER, isolation: 'none' },
  builder: WRITER,
  'lead-implementer': { ...WRITER, role: 'coordinator' },
  'declared-builder': { ...WRITER, returnContract: 'implementer' },
  'quiet-reviewer': { ...READER, isolation: 'none', returnContract: 'none' },
}

function installProfiles(home: string): void {
  fs.mkdirSync(path.join(home, 'profiles'))
  for (const [name, body] of Object.entries(USER_PROFILES))
    fs.writeFileSync(
      path.join(home, 'profiles', `${name}.json`),
      JSON.stringify({ surface: 'headless', ...body }),
    )
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  const home = tmp('agent-chat-contract-')
  process.env.AGENT_CHAT_HOME = home
  installProfiles(home)
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: { platform: 'linux', spawn: liveChild } })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const spawnReq = (over: Record<string, unknown> = {}) => ({
  name: 'worker',
  profile: 'implementer',
  brief: 'add the parser',
  requestedBy: 'coord',
  cwd: tmp('agent-chat-ws-'),
  isolation: 'none' as const,
  surface: 'headless' as const,
  ...over,
})

/** What the headless process is handed on stdin. */
async function delivered(over: Record<string, unknown> = {}): Promise<{ text: string; warnings: string[] }> {
  const result = await supervisor.spawn(spawnReq(over))
  expect(result.ok).toBe(true)
  return { text: readLaunchPlan(result.agentId as string).stdin ?? '', warnings: result.warnings ?? [] }
}

const block = (contract: ReturnContract, spawner = 'coord'): string =>
  (readContract(contract) as string).replaceAll('<spawner>', spawner)

const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** Counted with whitespace collapsed, because a pasted block is rewrapped. */
const occurrences = (text: string, part: string): number => flat(text).split(flat(part)).length - 1

/** One line per contract that only that contract's block contains. */
const MARKER: Record<ReturnContract, string> = {
  implementer: 'LAST action must be chat_send to',
  reviewer: 'Verdict: MERGE',
}

/** The block as the skill file carried it before this change, filled in the way a coordinator pasted it. */
const OLDER_IMPLEMENTER_BLOCK = [
  'Check `gh api repos/acme/widgets --jq .visibility`. In a public repo, never commit or paste captured',
  'real data into code, fixtures, PR bodies or comments. First run `git log origin/main --oneline --grep WX-1`',
  'and stop if it has landed. Make GitHub writes through `agent-chat gh-write -- <gh args>` when',
  '`agent-chat gh-write --help` works; otherwise, on a 403 "API rate limit exceeded" with core quota left,',
  'wait 5 minutes and retry once. You are NOT done at "PR opened". Your LAST action must be',
  'chat_send to coord starting with `Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`,',
  '`PR: acme/widgets#<n>` and `Head: <full sha>` lines, then CI status.',
].join('\n')

const OLDER_REVIEWER_BLOCK = [
  'Your LAST action is chat_send to coord starting with exactly these three lines:',
  'Verdict: MERGE            (or FIX_FIRST)',
  'PR: acme/widgets#7',
  'Head: <full 40-hex head sha you reviewed>',
  'then blocking items before nits. Under 1,200 characters.',
].join('\n')

describe('the contract file', () => {
  it.each(RETURN_CONTRACTS)('holds a %s block that names the spawner only by placeholder', contract => {
    const text = readContract(contract) as string

    expect(text).toContain('<spawner>')
    expect(carriesContract(text, contract)).toBe(true)
    expect(text).not.toMatch(/\/Users\/\w|@\w+\.\w+|[0-9a-f]{40}/)
  })

  it('warns and leaves the brief alone when the file is missing', () => {
    const profile = BUILTIN_PROFILES.find(p => p.name === 'implementer') as AgentProfile
    const file = path.join(tmp('agent-chat-nofile-'), 'return-contract.md')

    const result = withReturnContract({
      brief: 'add the parser',
      profile,
      spawner: 'coord',
      resumed: false,
      file,
    })

    expect(result.brief).toBe('add the parser')
    expect(result.warnings.join(' ')).toMatch(/no implementer return contract in .*spawned without it/)
  })
})

describe('a spawn by a registered session', () => {
  it.each([
    ['implementer', 'implementer'],
    ['zz-implementer', 'implementer'],
    ['zz-implementer-lite', 'implementer'],
    ['declared-builder', 'implementer'],
    ['reviewer', 'reviewer'],
    ['zz-reviewer', 'reviewer'],
  ] as const)('hands a %s agent the %s block exactly once', async (profile, contract) => {
    const { text, warnings } = await delivered({ profile })

    expect(occurrences(text, block(contract))).toBe(1)
    expect(occurrences(text, MARKER[contract])).toBe(1)
    expect(text.indexOf('add the parser')).toBeLessThan(text.indexOf(block(contract)))
    expect(warnings.join(' ')).not.toMatch(/return contract/)
  })

  // Mutation caught: appending for every profile hands these a block.
  it.each(['explorer', 'planner', 'peer', 'researcher', 'builder', 'lead-implementer', 'quiet-reviewer'])(
    'hands a %s agent no block',
    async profile => {
      const { text } = await delivered({ profile })

      expect(text).toContain('add the parser')
      for (const contract of RETURN_CONTRACTS) expect(text).not.toContain(MARKER[contract])
    },
  )

  // Mutation caught: leaving the placeholder unfilled.
  it.each(RETURN_CONTRACTS)('names the spawner in the %s block', async contract => {
    const { text } = await delivered({ profile: contract, requestedBy: 'north-seat' })

    expect(text).not.toContain('<spawner>')
    expect(flat(text)).toContain('chat_send to north-seat')
  })

  it('hands a CLI spawn no block, since nobody registered is there to report to', async () => {
    const { text } = await delivered({ requestedBy: 'human' })

    expect(text).not.toContain(MARKER.implementer)
  })

  it('leaves the logged brief as the caller wrote it', async () => {
    await delivered()

    expect(core.events.agentEvents().find(r => r.kind === 'agent_spawned')?.body).toBe('add the parser')
  })
})

// Mutation caught: appending without the duplicate check makes each count 2.
describe('a brief that already carries the contract', () => {
  it.each([
    ['implementer', 'whole', () => block('implementer')],
    ['implementer', 'in the older wording', () => OLDER_IMPLEMENTER_BLOCK],
    ['reviewer', 'whole', () => block('reviewer')],
    ['reviewer', 'in the older wording', () => OLDER_REVIEWER_BLOCK],
  ] as const)(
    'does not hand a %s agent a second copy when it is pasted %s',
    async (profile, _how, pasted) => {
      const { text, warnings } = await delivered({ profile, brief: `add the parser\n\n${pasted()}` })

      expect(occurrences(text, MARKER[profile])).toBe(1)
      expect(text).toContain(pasted())
      expect(warnings.join(' ')).toMatch(new RegExp(`already carries the ${profile} return contract`))
    },
  )

  it('still appends the reviewer block when the brief quotes only the implementer one', async () => {
    const { text } = await delivered({ profile: 'reviewer', brief: `check this:\n\n${block('implementer')}` })

    expect(occurrences(text, block('reviewer'))).toBe(1)
  })
})

// Mutation caught: appending again on resume puts the marker in both of these.
describe('a resumed conversation', () => {
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

  function writeTranscript(cwd: string, sessionId: string, account?: string): void {
    const file = transcriptPath(cwd, sessionId, account)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')
  }

  it('is not handed the block by a resume_session spawn', async () => {
    const cwd = tmp('agent-chat-ws-')
    const account = tmp('agent-chat-account-')
    writeTranscript(cwd, SESSION, account)

    const { text } = await delivered({ cwd, spawnerConfigDir: account, resumeSession: SESSION })

    expect(text).toContain('add the parser')
    expect(text).not.toContain(MARKER.implementer)
  })

  it('is not handed the block again by agent_resume', async () => {
    const spawned = await supervisor.spawn(spawnReq({ spawnerConfigDir: tmp('agent-chat-account-') }))
    const agentId = spawned.agentId as string
    expect(readLaunchPlan(agentId).stdin).toContain(MARKER.implementer)
    const exit = (supervisor as unknown as { recordExit: (id: string, o: unknown) => Promise<void> })
      .recordExit
    await exit.call(supervisor, agentId, { code: 0, signal: null })
    const agent = core.agents.get(agentId)!
    writeTranscript(agent.cwd, agent.sessionId, agent.configDir)

    const resumed = await supervisor.resume('worker', {
      message: 'fix the review items',
      requestedBy: 'coord',
    })

    expect(resumed.ok).toBe(true)
    expect(readLaunchPlan(agentId).stdin).toBe('fix the review items')
  })
})

describe('which contract a profile takes', () => {
  const profile = (name: string, body: Record<string, unknown>): AgentProfile =>
    parseProfile(name, { surface: 'headless', ...body }) as AgentProfile

  it.each([
    ['preimplementer', WRITER],
    ['zz-implementer-reviewer', WRITER],
    ['zz-implementer', { ...READER, isolation: 'none' }],
    ['zz-reviewer', WRITER],
  ])('gives %s none, because its name and grants do not agree on one', (name, body) => {
    expect(contractOf(profile(name, body))).toBeUndefined()
  })

  it('takes the declared contract over the one its name suggests', () => {
    expect(contractOf(profile('zz-reviewer', { ...WRITER, returnContract: 'implementer' }))).toBe(
      'implementer',
    )
  })

  it('refuses a profile file that declares a contract that does not exist', () => {
    expect(parseProfile('zz', { surface: 'headless', ...WRITER, returnContract: 'planner' })).toEqual({
      error: 'zz: "returnContract" must be one of implementer, reviewer, none',
    })
  })
})
