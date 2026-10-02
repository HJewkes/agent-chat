import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { BUILTIN_PROFILES, parseProfile } from '../agents/profiles.js'
import { carriesContract, contractOf, withReturnContract } from '../agents/return-contract.js'
import {
  IMPLEMENTER_WITHOUT_SHEPHERD,
  MAX_BLOCK_CHARS,
  RETURN_CONTRACT_BLOCKS,
  SHEPHERD_NONE_MARKER,
} from '../agents/return-contract-blocks.js'
import { transcriptPath } from '../agents/transcript.js'
import { RETURN_CONTRACTS, type AgentProfile, type ReturnContract } from '../agents/types.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-286. The broker appends the return contract that fits the profile, once,
 * with the spawner's name in it. The spawn tests read what the launched process
 * is actually handed.
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

/** Profile files as a user would have installed them: only the last two carry a `returnContract` field. */
const USER_PROFILES: Record<string, Record<string, unknown>> = {
  'zz-implementer': WRITER,
  'zz-implementer-lite': WRITER,
  zz_implementer: WRITER,
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
const SURFACE = { platform: 'linux' as const, spawn: liveChild }

beforeEach(() => {
  const home = tmp('agent-chat-contract-')
  process.env.AGENT_CHAT_HOME = home
  installProfiles(home)
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, { surface: SURFACE })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  vi.restoreAllMocks()
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
  RETURN_CONTRACT_BLOCKS[contract].split('<spawner>').join(spawner)

const flat = (text: string): string => text.replace(/\s+/g, ' ')

/** Counted with whitespace collapsed, because a pasted block is rewrapped. */
const occurrences = (text: string, part: string): number => flat(text).split(flat(part)).length - 1

/** One phrase per contract that only that contract's block contains. */
const MARKER: Record<ReturnContract, string> = {
  implementer: 'LAST action must be chat_send to',
  reviewer: 'Verdict: MERGE',
}

const PASTED_WARNING = /already carries the (implementer|reviewer) return contract/
const OWN_FORMAT_WARNING = /has a Status: or Verdict: line of its own/

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

const STATUS = 'Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT'
const PR_AND_HEAD = 'PR: acme/widgets#7\nHead: <full sha>'

describe('the compiled blocks', () => {
  it.each(RETURN_CONTRACTS)('hold a %s block that is whole, generic and under the size cap', contract => {
    const text = RETURN_CONTRACT_BLOCKS[contract]

    expect(text).toContain('<spawner>')
    expect(carriesContract(text, contract)).toBe(true)
    expect(text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS)
    expect(text).not.toMatch(/\/Users\/\w|@\w+\.\w+|[0-9a-f]{40}|npm ci|agent-chat,/)
  })

  it.each(RETURN_CONTRACTS)('tell a %s never to end a turn on a background task or a sleep', contract => {
    expect(flat(RETURN_CONTRACT_BLOCKS[contract])).toContain(
      'Never end a turn on a background task, a sleep or a ScheduleWakeup',
    )
  })
})

describe('the GitHub write path (CC-456)', () => {
  it('names gh-write as the only write path, with no fallback to plain gh', () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer)

    expect(text).toContain('`agent-chat gh-write -- <gh args>`, the only write path')
    expect(text).not.toContain('otherwise use plain `gh`')
  })
})

describe('the check-run rule (CC-357)', () => {
  // Mutation caught: reverting the implementer CI line to a bare "then CI status".
  it('has the implementer paste each check-run at the head instead of reporting "green"', () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer)

    expect(text).toContain(
      'CI: <paste of: gh api repos/<owner>/<repo>/commits/<head>/check-runs --paginate --jq \'.check_runs[]|"\\(.name) \\(.conclusion)"\'>',
    )
    expect(text).toContain('never "green" alone')
    expect(text).toContain('`gh run watch` covers only one workflow')
    expect(text).toContain('a skipped check (std / compat) is no failure')
    expect(text).toContain('"required" means the required contexts on the default branch')
    expect(text).toContain('as it stands at the push (you do not wait for CI)')
  })

  // Mutation caught: dropping the reviewer's check-run line.
  it('has the reviewer confirm every required check-run at the head before a MERGE', () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.reviewer)

    expect(text).toContain('Before MERGE, confirm every required check-run (one branch protection names)')
    expect(text).toContain('commits/<head>/check-runs --paginate')
    expect(text).toContain('FIX_FIRST if a required one failed')
    expect(text).toContain('A skipped check (std / compat) is not a failure')
  })
})

describe('a spawn by a registered session', () => {
  it.each([
    ['implementer', 'implementer'],
    ['zz-implementer', 'implementer'],
    ['zz-implementer-lite', 'implementer'],
    ['zz_implementer', 'implementer'],
    ['declared-builder', 'implementer'],
    ['reviewer', 'reviewer'],
    ['zz-reviewer', 'reviewer'],
  ] as const)('hands a %s agent the %s block exactly once', async (profile, contract) => {
    const { text, warnings } = await delivered({ profile })

    expect(occurrences(text, block(contract))).toBe(1)
    expect(occurrences(text, MARKER[contract])).toBe(1)
    // Mutation caught: joining the brief and the block without a blank line.
    expect(text).toContain(`add the parser\n\n${block(contract)}`)
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

  // Mutation caught: a string replacement expands `$&` to `<spawner>`.
  it('writes a spawner name holding a replacement pattern as plain text', async () => {
    const { text } = await delivered({ requestedBy: "co$&rd$'" })

    expect(text).toContain("chat_send to co$&rd$' starting with")
    expect(text).not.toContain('<spawner>')
  })

  it('hands a CLI spawn no block, since nobody registered is there to report to', async () => {
    const { text } = await delivered({ requestedBy: 'human' })

    expect(text).not.toContain(MARKER.implementer)
  })

  it('leaves the logged brief as the caller wrote it', async () => {
    await delivered()

    expect(core.events.agentEvents().find(r => r.kind === 'agent_spawned')?.body).toBe('add the parser')
  })

  it('hands a successor spawned with a predecessor the block, after its assignment', async () => {
    await delivered({ name: 'first' })

    const { text } = await delivered({ name: 'second', brief: 'address the review', predecessor: 'first' })

    expect(occurrences(text, block('implementer'))).toBe(1)
    expect(text).toContain(`address the review\n\n${block('implementer')}`)
  })

  // Mutation caught: reading the block from a file at spawn time.
  it('reads no contract from disk, so a second spawn gets the text the broker started with', async () => {
    const first = await delivered({ name: 'first' })
    const reads = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'existsSync'), vi.spyOn(fs, 'statSync')]

    const second = await delivered({ name: 'second' })

    const paths = reads.flatMap(spy => spy.mock.calls.map(call => String(call[0])))
    expect(paths.filter(file => /return-contract|[\\/]skills[\\/]/.test(file))).toEqual([])
    expect(second.text).toContain(block('implementer'))
    expect(occurrences(first.text, block('implementer'))).toBe(1)
  })
})

describe('a spawn that opts out with return_contract none', () => {
  it.each(RETURN_CONTRACTS)('hands a %s agent only the caller’s brief', async profile => {
    const { text, warnings } = await delivered({ profile, returnContract: 'none' })

    expect(text).toContain('add the parser')
    expect(text).not.toContain(MARKER[profile])
    expect(warnings.join(' ')).not.toMatch(/return contract/)
  })

  // Mutation caught: dropping returnContract in handleSpawn appends the block to the second spawn.
  it('carries the opt-out from the socket frame to the delivered brief', async () => {
    const server = new SocketServer(core, { surface: SURFACE })
    const replies: ServerMessage[] = []
    const write = (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
      return true
    }
    const conn = { write, end: () => undefined } as unknown as Conn
    server.handleMessage(conn, {
      t: 'register',
      name: 'coord',
      workingOn: 'x',
      cwd: tmp('agent-chat-ws-'),
      pid: 1,
    })
    const frame = { t: 'spawn', profile: 'implementer', brief: 'add the parser', cwd: tmp('agent-chat-ws-') }
    const spawned = async (name: string, extra: object): Promise<string> => {
      server.handleMessage(conn, {
        ...frame,
        name,
        isolation: 'none',
        surface: 'headless',
        ...extra,
      } as never)
      const result = await vi.waitFor(() => {
        const found = replies.find(r => r.t === 'spawn_result' && r.name === name)
        if (found === undefined) throw new Error('no spawn_result yet')
        return found as Extract<ServerMessage, { t: 'spawn_result' }>
      })
      return readLaunchPlan(result.agentId as string).stdin ?? ''
    }

    expect(await spawned('plain', {})).toContain(block('implementer'))
    expect(await spawned('quiet', { returnContract: 'none' })).not.toContain(MARKER.implementer)
    server.close()
  })
})

// Mutation caught: appending without the duplicate check makes each count 2.
describe('a brief that already carries the contract', () => {
  const PASTED: ReadonlyArray<readonly [ReturnContract, string, string]> = [
    ['implementer', 'whole', block('implementer')],
    ['implementer', 'in the older wording', OLDER_IMPLEMENTER_BLOCK],
    [
      'implementer',
      'with a lower-case last action',
      `your last action is chat_send: ${STATUS}\n${PR_AND_HEAD}`,
    ],
    [
      'implementer',
      'with spaces around the bars',
      `LAST action: Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT\n${PR_AND_HEAD}`,
    ],
    ['reviewer', 'whole', block('reviewer')],
    ['reviewer', 'in the older wording', OLDER_REVIEWER_BLOCK],
    ['reviewer', 'as MERGE or FIX_FIRST', `Verdict: MERGE or FIX_FIRST\n${PR_AND_HEAD}`],
    ['reviewer', 'as MERGE | FIX_FIRST', `Verdict: MERGE | FIX_FIRST\n${PR_AND_HEAD}`],
  ]

  it.each(PASTED)(
    'does not hand a %s agent a second copy when it is pasted %s',
    async (profile, _how, pasted) => {
      const brief = `add the parser\n\n${pasted}`

      const { text, warnings } = await delivered({ profile, brief })

      expect(text).toBe(brief)
      expect(warnings.join(' ')).toMatch(PASTED_WARNING)
    },
  )
})

/** Each brief lacks one of the lines the spawner's tooling parses, so the agent would have no usable contract. */
describe('a brief that only quotes part of the contract', () => {
  it.each([
    ['implementer', 'only the Status line', `Reports start with \`${STATUS}\`.`],
    ['implementer', 'no Status line', `Your LAST action must be chat_send to coord.\n${PR_AND_HEAD}`],
    ['implementer', 'two of the four Status values', `LAST action: Status: DONE|BLOCKED\n${PR_AND_HEAD}`],
    ['implementer', 'no last-action rule', `Report ${STATUS}\n${PR_AND_HEAD}`],
    ['implementer', 'no PR line', `LAST action: ${STATUS}\nHead: <full sha>`],
    ['implementer', 'no Head line', `LAST action: ${STATUS}\nPR: acme/widgets#7`],
    ['reviewer', 'only the Verdict line', 'Verdict: MERGE            (or FIX_FIRST)'],
    ['reviewer', 'no Verdict line', PR_AND_HEAD],
    ['reviewer', 'a Verdict line with one value', `Verdict: MERGE\n${PR_AND_HEAD}`],
    ['reviewer', 'no PR line', 'Verdict: MERGE (or FIX_FIRST)\nHead: <full 40-hex head sha>'],
    ['reviewer', 'no Head line', 'Verdict: MERGE (or FIX_FIRST)\nPR: acme/widgets#7'],
  ] as const)('still hands a %s agent the block when the brief has %s', async (profile, _what, quoted) => {
    const { text, warnings } = await delivered({ profile, brief: `add the parser\n\n${quoted}` })

    expect(occurrences(text, block(profile))).toBe(1)
    expect(warnings.join(' ')).not.toMatch(PASTED_WARNING)
  })

  it('still appends the reviewer block when the brief quotes the whole implementer one', async () => {
    const { text } = await delivered({ profile: 'reviewer', brief: `check this:\n\n${block('implementer')}` })

    expect(occurrences(text, block('reviewer'))).toBe(1)
  })
})

describe('a brief with a report format of its own', () => {
  // Mutation caught: dropping the warning leaves the caller unaware the agent holds two formats.
  it.each([
    ['reviewer', 'Report `Verdict: APPROVE | CHANGES` first.'],
    ['reviewer', 'Verdict: REQUEST_CHANGES or APPROVE'],
    ['implementer', 'End with:\nStatus: ok or failed'],
  ] as const)('appends the %s block and warns that both are there', async (profile, own) => {
    const { text, warnings } = await delivered({ profile, brief: `add the parser\n\n${own}` })

    expect(occurrences(text, block(profile))).toBe(1)
    expect(warnings.join(' ')).toMatch(OWN_FORMAT_WARNING)
    expect(warnings.join(' ')).toContain('return_contract: "none"')
  })

  it('does not warn about a brief that only mentions status in passing', async () => {
    const { warnings } = await delivered({ brief: 'fix the status: field and the HTTP Status codes' })

    expect(warnings.join(' ')).not.toMatch(OWN_FORMAT_WARNING)
  })
})

// Mutation caught: appending on any of these paths puts the marker in the relaunched plan.
describe('a conversation that continues', () => {
  const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'

  function writeTranscript(cwd: string, sessionId: string, account?: string): void {
    const file = transcriptPath(cwd, sessionId, account)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}\n')
  }

  /** An implementer that got the block at spawn and has since exited, with a transcript to resume. */
  async function finishedWorker(): Promise<string> {
    const spawned = await supervisor.spawn(spawnReq({ spawnerConfigDir: tmp('agent-chat-account-') }))
    const agentId = spawned.agentId as string
    expect(readLaunchPlan(agentId).stdin).toContain(MARKER.implementer)
    const exit = (supervisor as unknown as { recordExit: (id: string, o: unknown) => Promise<void> })
      .recordExit
    await exit.call(supervisor, agentId, { code: 0, signal: null })
    const agent = core.agents.get(agentId)!
    writeTranscript(agent.cwd, agent.sessionId, agent.configDir)
    return agentId
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
    const agentId = await finishedWorker()

    const resumed = await supervisor.resume('worker', {
      message: 'fix the review items',
      requestedBy: 'coord',
    })

    expect(resumed.ok).toBe(true)
    expect(readLaunchPlan(agentId).stdin).toBe('fix the review items')
  })

  it('is not handed the block again by a seat watchdog resume', async () => {
    const agentId = await finishedWorker()

    const resumed = await supervisor.resume('worker', { message: 'Watchdog: wake', source: 'watchdog' })

    expect(resumed.ok).toBe(true)
    expect(readLaunchPlan(agentId).stdin).toBe('Watchdog: wake')
  })

  it('is not handed the block by a teleport into a successor', async () => {
    const profile = BUILTIN_PROFILES.find(p => p.name === 'implementer') as AgentProfile

    await supervisor.relaunch({
      agentId: 'successor-1',
      name: 'worker',
      profile: { ...profile, isolation: 'none' },
      brief: 'carry on from the handoff',
      cwd: tmp('agent-chat-ws-'),
      surface: 'headless',
      preamble: 'you are the continuation',
      meta: {},
    })

    expect(readLaunchPlan('successor-1').stdin).toBe('carry on from the handoff')
  })
})

describe('which contract a profile takes', () => {
  const profile = (name: string, body: Record<string, unknown>): AgentProfile =>
    parseProfile(name, { surface: 'headless', ...body }) as AgentProfile

  const ONLY_READS = { model: 'opus', allowedTools: ['Read', 'Bash'], isolation: 'none' }
  const EDIT_TAKEN_AWAY = { ...WRITER, disallowedTools: ['Edit'] }

  it.each([
    ['preimplementer', WRITER],
    ['zz-implementer-reviewer', WRITER],
    ['zz-implementer', { ...READER, isolation: 'none' }],
    ['zz-implementer', ONLY_READS],
    ['zz-implementer', EDIT_TAKEN_AWAY],
    ['zz-reviewer', WRITER],
  ])('gives %s none, because its name and grants do not agree on one', (name, body) => {
    expect(contractOf(profile(name, body))).toBeUndefined()
  })

  it.each([
    ['zz-reviewer', ONLY_READS],
    ['zz-reviewer', EDIT_TAKEN_AWAY],
    ['zz_reviewer', { ...READER, isolation: 'none' }],
  ])('gives %s the reviewer block when Edit is not granted or is taken away', (name, body) => {
    expect(contractOf(profile(name, body))).toBe('reviewer')
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

  it('leaves a resumed or opted-out brief byte-identical', () => {
    const builtin = BUILTIN_PROFILES.find(p => p.name === 'reviewer') as AgentProfile
    const base = { brief: 'review it', profile: builtin, spawner: 'coord' }

    expect(withReturnContract({ ...base, resumed: true })).toEqual({ brief: 'review it', warnings: [] })
    expect(withReturnContract({ ...base, resumed: false, requested: 'none' })).toEqual({
      brief: 'review it',
      warnings: [],
    })
  })
})

describe('the Shepherd handoff (TP-468)', () => {
  // Mutation caught: restoring "Wait for CI with `gh run watch`" in the implementer block.
  it('ends the implementer at pushed and registers the PR with a kind', () => {
    const text = flat(RETURN_CONTRACT_BLOCKS.implementer)

    expect(text).toContain('titan-factory shepherd register <owner>/<repo>#<n> --task <initiative>/<ID>')
    expect(text).toContain('--kind <correctness|security|feature|refactor>')
    expect(text).toContain('never wait on CI')
    expect(text).not.toContain('gh run watch <id>')
    expect(text).toContain('Shepherd: refused <first stderr line>')
  })

  // Mutation caught: any change to the three lines bin/premerge and Shepherd parse.
  it('pins the reviewer verdict block', () => {
    expect(RETURN_CONTRACT_BLOCKS.reviewer).toContain(
      'exactly these three lines:\nVerdict: MERGE            (or FIX_FIRST)\nPR: <owner>/<repo>#<n>\nHead: <full 40-hex head sha>\n',
    )
  })
})

describe('a brief that opts out of Shepherd (CC-452)', () => {
  const REGISTER = 'titan-factory shepherd register <owner>/<repo>#<n>'
  const CI_WAIT = "Wait for CI as the brief directs and report each check-run's conclusion at the final head"

  it('keeps the variant block whole, generic and under the size cap', () => {
    expect(IMPLEMENTER_WITHOUT_SHEPHERD).toContain('<spawner>')
    expect(carriesContract(IMPLEMENTER_WITHOUT_SHEPHERD, 'implementer')).toBe(true)
    expect(IMPLEMENTER_WITHOUT_SHEPHERD.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS)
  })

  // Mutation caught: ignoring the marker hands the agent the register sentence again.
  it.each([SHEPHERD_NONE_MARKER, 'shepherd: NONE', '   Shepherd: none\t'])(
    'drops the register and no-wait text for the line %j',
    async marker => {
      const brief = `add the parser\n${marker}\nwait for CI with bin/ci-wait`

      const { text } = await delivered({ brief })

      const appended = flat(text.slice(brief.length))
      expect(appended).not.toContain(REGISTER)
      expect(appended).not.toContain('never wait on CI')
      expect(appended).not.toContain('you do not wait for CI')
      expect(appended).toContain('Do not run `titan-factory shepherd register`.')
      expect(appended).toContain(CI_WAIT)
      expect(appended).toContain('chat_send to coord')
    },
  )

  // Mutation caught: a substring test opts out a brief that only talks about the marker.
  it('keeps Shepherd for a brief that mentions the marker mid-sentence', async () => {
    const brief = 'add the parser; a seat may write Shepherd: none in its brief'

    const { text } = await delivered({ brief })

    expect(text).toBe(`${brief}\n\n${block('implementer')}`)
  })

  it('hands a brief without the marker the default block unchanged', async () => {
    const { text } = await delivered()

    expect(text).toBe(`add the parser\n\n${block('implementer')}`)
    expect(flat(text)).toContain(REGISTER)
  })

  it('leaves a reviewer brief carrying the marker on the reviewer block', async () => {
    const { text } = await delivered({ profile: 'reviewer', brief: `review it\n${SHEPHERD_NONE_MARKER}` })

    expect(occurrences(text, block('reviewer'))).toBe(1)
  })

  it('does not double a brief that already pastes the contract and carries the marker', async () => {
    const brief = `add the parser\n${SHEPHERD_NONE_MARKER}\n\n${block('implementer')}`

    const { text, warnings } = await delivered({ brief })

    expect(text).toBe(brief)
    expect(warnings.join(' ')).toMatch(PASTED_WARNING)
  })
})

describe('the load-test rule (CC-473)', () => {
  // Mutation caught: restoring the pkill -f line in either implementer block.
  it.each([
    ['default', RETURN_CONTRACT_BLOCKS.implementer],
    ['Shepherd: none', IMPLEMENTER_WITHOUT_SHEPHERD],
  ])('in the %s block applies only to an asked-for load test and kills by recorded PID', (_which, text) => {
    expect(text).not.toContain('pkill')
    expect(flat(text)).toContain('Only when the brief asks for a load test: record the PID of each burner')
    expect(flat(text)).toContain('confirm with `pgrep` that none survive')
  })
})
