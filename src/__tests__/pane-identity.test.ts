import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import {
  coordinatorOf,
  hashedColour,
  itermIdentity,
  PANE_PALETTE,
  paneColour,
  seatPrefixes,
  type PaneColourConfig,
} from '../agents/pane-identity.js'
import { paneEscapes, type PaneSources } from '../agents/run-agent.js'
import type { AgentProfile, LaunchPlan } from '../agents/types.js'
import { resolvePaneColourConfig } from '../config.js'
import { SURFACE_NAMES } from '../protocol.js'

/** CC-327: an interactive agent's pane names it and wears its coordinator's colour. */

const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const SEATS = [
  { name: 'alpha-coord', prefix: 'ac' },
  { name: 'beta-coord', prefix: 'bc' },
]
const NO_COLOURS: PaneColourConfig = { seats: {}, profiles: {} }
const ITERM = { TERM_PROGRAM: 'iTerm.app' }

const sources = (colours: PaneColourConfig = NO_COLOURS): PaneSources => ({
  seats: () => SEATS,
  colours: () => colours,
})

const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  agentId: 'ag000001',
  bin: 'claude',
  args: [],
  cwd: '/repo',
  env: { AGENT_CHAT_PROFILE: 'implementer' },
  title: 'ac-task-1',
  surface: 'iterm-tab',
  ...over,
})

/** Tab colour #3d85c6 and badge "ac-task-1", byte for byte as iTerm reads them. */
const ITERM_BYTES =
  '\x1b]0;ac-task-1\x07' +
  '\x1b]6;1;bg;red;brightness;61\x07' +
  '\x1b]6;1;bg;green;brightness;133\x07' +
  '\x1b]6;1;bg;blue;brightness;198\x07' +
  '\x1b]1337;SetBadgeFormat=YWMtdGFzay0x\x07'

describe('which coordinator a pane belongs to', () => {
  it('gives every agent of one seat, and the seat itself, the same colour', () => {
    const colours = ['ac-task-1', 'ac-task-2-other', 'alpha-coord'].map(name =>
      paneColour(name, 'implementer', SEATS, NO_COLOURS),
    )

    expect(new Set(colours).size).toBe(1)
    expect(colours[0]).toBe(hashedColour('alpha-coord'))
  })

  it('keeps one colour per seat across profiles, so a reviewer matches its implementer', () => {
    const colours: PaneColourConfig = { seats: {}, profiles: { reviewer: '#123456' } }

    expect(paneColour('ac-review-1', 'reviewer', SEATS, NO_COLOURS)).toBe(
      paneColour('ac-task-1', 'implementer', SEATS, NO_COLOURS),
    )
    expect(paneColour('zz-review-1', 'reviewer', SEATS, colours)).toBe('#123456')
  })

  it('falls back to the name root when no seat matches', () => {
    expect(coordinatorOf('zz-one', SEATS)).toBe('zz')
    expect(paneColour('zz-one', undefined, [], NO_COLOURS)).toBe(
      paneColour('zz-two', undefined, [], NO_COLOURS),
    )
  })

  it('lets a configured seat colour beat a profile colour and the hash', () => {
    const colours: PaneColourConfig = {
      seats: { 'alpha-coord': '#010203' },
      profiles: { implementer: '#aabbcc' },
    }

    expect(paneColour('ac-task-1', 'implementer', SEATS, colours)).toBe('#010203')
    expect(paneColour('bc-task-1', 'implementer', SEATS, colours)).toBe('#aabbcc')
  })

  it('hashes a coordinator to the same palette entry every time', () => {
    expect(PANE_PALETTE).toContain(hashedColour('alpha-coord'))
    expect(hashedColour('alpha-coord')).toBe('#6aa84f')
    expect(hashedColour('beta-coord')).toBe('#c2478f')
  })
})

describe('the escape bytes run-agent writes', () => {
  it('writes the title, tab colour and badge in iTerm', () => {
    const configured = sources({ seats: { 'alpha-coord': '#3d85c6' }, profiles: {} })

    expect(paneEscapes(plan(), ITERM, configured)).toBe(ITERM_BYTES)
  })

  it('writes nothing at all for a headless agent, even inside iTerm', () => {
    expect(paneEscapes(plan({ surface: 'headless' }), ITERM, sources())).toBe('')
  })

  it('writes only the portable title in another terminal', () => {
    expect(paneEscapes(plan(), { TERM_PROGRAM: 'Apple_Terminal' }, sources())).toBe('\x1b]0;ac-task-1\x07')
  })

  it('emits one title sequence for a name that tries to inject a second escape', () => {
    const probe = 'x\x07\x1b]1337;SetBadgeFormat=cHduZWQ=\x07'
    const out = paneEscapes(plan({ title: probe }), ITERM, sources())

    expect(out.match(/\x1b\]0;/g)).toHaveLength(1)
    expect(out.match(/\x1b\]1337;/g)).toHaveLength(1)
    const title = /\x1b\]0;([^\x07]*)\x07/.exec(out)?.[1] ?? ''
    expect(title).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
    expect(paneEscapes(plan({ title: 'a\nb\x1b\\c' }), { TERM_PROGRAM: 'x' }, sources())).toBe(
      '\x1b]0;ab\\c\x07',
    )
  })

  it('base64-encodes the badge so a name with escapes cannot break out of it', () => {
    expect(itermIdentity('a\x07b', { r: 0, g: 0, b: 0 })).toContain('SetBadgeFormat=YQdi\x07')
  })
})

describe('the session name Claude Code shows', () => {
  const profile: AgentProfile = {
    name: 'implementer',
    description: 'd',
    model: 'sonnet',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'iterm-tab',
    promptPrelude: '',
  }

  it('passes the agent name as --name on every surface', () => {
    for (const surface of SURFACE_NAMES) {
      const { args } = buildLaunchPlan({
        agentId: 'ag000001',
        sessionId: '00000000-0000-4000-8000-000000000001',
        name: 'ac-task-1',
        profile,
        brief: 'b',
        cwd: '/repo',
        mcpConfigPath: '/m.json',
        surface,
      })
      expect(args[args.indexOf('--name') + 1]).toBe('ac-task-1')
    }
  })
})

describe('run-agent against a home and an autonomy root on disk', () => {
  let dir: string
  let fakeClaude: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pane-'))
    fakeClaude = path.join(dir, 'fake-claude.js')
    fs.writeFileSync(fakeClaude, "process.stdout.write('fake-claude-ran')\n")
    const autonomy = path.join(dir, 'aw', 'claude-channels', 'sources', 'autonomy')
    fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
    fs.writeFileSync(path.join(autonomy, 'charter.md'), '---\nseats: [alpha-coord, beta-coord]\n---\n')
    fs.writeFileSync(path.join(autonomy, 'seats', 'alpha-coord.md'), '---\nprefix: ac\npool: p\n---\n')
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ paneColours: { seats: { 'alpha-coord': '#3d85c6' } } }),
    )
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const run = (surface: LaunchPlan['surface']) => {
    const agentDir = path.join(dir, 'agents', 'ag000001')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'plan.json'),
      JSON.stringify(plan({ args: [fakeClaude], cwd: dir, surface })),
    )
    return spawnSync(process.execPath, [CLI, 'run-agent', 'ag000001'], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        ...ITERM,
        AGENT_CHAT_HOME: dir,
        AGENT_CHAT_ACTIVE_WORK_ROOT: path.join(dir, 'aw'),
        AGENT_CHAT_CLAUDE: process.execPath,
      },
    })
  }

  it('reads the seat prefix from the charter', () => {
    expect(seatPrefixes(path.join(dir, 'aw', 'claude-channels', 'sources', 'autonomy'))).toEqual([
      { name: 'alpha-coord', prefix: 'ac' },
    ])
  })

  it('degrades to no seat prefix when the charter file is missing', () => {
    expect(seatPrefixes(path.join(dir, 'no-such-autonomy'))).toEqual([])
  })

  it('writes the exact iTerm bytes before claude starts in a tab', () => {
    expect(run('iterm-tab').stdout).toBe(`${ITERM_BYTES}fake-claude-ran`)
  })

  it('writes no escape bytes before a headless claude', () => {
    expect(run('headless').stdout).toBe('fake-claude-ran')
  })

  it('drops a malformed configured colour rather than emitting it', () => {
    process.env.AGENT_CHAT_HOME = dir
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        paneColours: { seats: { 'alpha-coord': 'blue' }, profiles: { reviewer: '#00ff00' } },
      }),
    )

    expect(resolvePaneColourConfig()).toEqual({ seats: {}, profiles: { reviewer: '#00ff00' } })
  })
})
