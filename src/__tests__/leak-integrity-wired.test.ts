import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookSettingsPath, writeLaunchFiles } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { relaunchRefusal } from '../agents/relaunch-integrity.js'
import type { AgentProfile, LaunchPlanInput } from '../agents/types.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { integrityDenial, type AskBroker } from '../cli/verbs/leak-integrity.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * TP-4256 A3 acceptance rows: the wired path, from `writeLaunchFiles` registering a launch with the
 * broker, through the hook's records and `integrity_check`, to `run-agent`'s relaunch check. Every
 * write is a real `bash -c` against a synthetic HOME under the test tmpdir. The shapes are S1-S17 of
 * the A5 redesign, plus FIFO and /dev/zero swaps. Names, ids and paths are synthetic.
 */

const AGENT = 'ag000001'
const SIBLING = 'ag000002'
const SESSION = '00000000-0000-4000-8000-0000000000a3'
const servers: SocketServer[] = []
const dirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) {
    execFileSync('chmod', ['-R', 'u+rwx', dir])
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const profile: AgentProfile = {
  name: 'test',
  description: 'a profile',
  model: 'sonnet',
  allowedTools: ['Read'],
  isolation: 'none',
  surface: 'headless',
  promptPrelude: 'Be brief.',
}

const planInput = (agentId: string): LaunchPlanInput => ({
  agentId,
  sessionId: '00000000-0000-4000-8000-000000000001',
  name: `scout-${agentId}`,
  profile,
  brief: 'find every caller of foo()',
  cwd: '/repo',
  cwdHoldsUserSettings: false,
  adopted: false,
  mcpConfigPath: `/state/agents/${agentId}/mcp.json`,
})

function answer<T extends ServerMessage['t']>(server: SocketServer, frame: ClientMessage, t: T) {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  server.handleMessage(conn, frame)
  return frames.find(frame => frame.t === t) as Extract<ServerMessage, { t: T }>
}

/** A broker, a synthetic home with a .zshrc and a session snapshot, and two launches written through the broker. */
function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integrity-wired-')))
  dirs.push(root)
  const home = path.join(root, 'home')
  const acHome = path.join(home, '.agent-chat')
  const configDir = path.join(home, '.claude')
  fs.mkdirSync(path.join(configDir, 'shell-snapshots'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'shell-snapshots', 'snapshot-zsh-1.sh'), 'export A=1\n')
  fs.writeFileSync(path.join(home, '.zshrc'), 'alias ll=ls\n')
  vi.stubEnv('HOME', home)
  vi.stubEnv('AGENT_CHAT_HOME', acHome)
  vi.stubEnv('ZDOTDIR', undefined)
  vi.stubEnv('BASH_ENV', undefined)
  vi.stubEnv('ENV', undefined)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(root, 'events.db')),
    registry: new Registry<Conn>(),
  })
  core.append({ kind: 'agent_spawned', actor: 'coord', target: 'scout', msgId: AGENT, body: 'work' })
  const server = new SocketServer(core)
  servers.push(server)
  const launch = (agentId: string): string => {
    writeLaunchFiles(buildLaunchPlan(planInput(agentId)), {}, undefined, server.launchIntegrity)
    return nonceIn(hookSettingsPath(agentId))
  }
  const nonce = launch(AGENT)
  launch(SIBLING)
  const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir }
  const ask: AskBroker = async frame => answer(server, frame, 'integrity_result')
  const hook = (n: string = nonce) => integrityDenial(n, JSON.stringify({ session_id: SESSION }), env, ask)
  const relaunch = () =>
    relaunchRefusal(AGENT, async agentId =>
      answer(server, { t: 'integrity_relaunch', agentId }, 'integrity_relaunch_result'),
    )
  const bash = (script: string): void => {
    execFileSync('bash', ['-c', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        AC: acHome,
        A: path.join(acHome, 'agents', AGENT),
        T: root,
      },
      cwd: root,
    })
  }
  const notices = () =>
    core.events.since(0, 500).filter(row => row.kind === 'notice' && row.meta?.agent_id === AGENT)
  return { home, acHome, nonce, launch, hook, relaunch, bash, notices }
}

const nonceIn = (settings: string): string => {
  const match = /--integrity '([0-9a-f]{64})'/.exec(fs.readFileSync(settings, 'utf8'))
  if (match?.[1] === undefined) throw new Error(`no --integrity nonce in ${settings}`)
  return match[1]
}

const isRoot = process.getuid?.() === 0
const caseInsensitiveTmp =
  fs.existsSync(os.tmpdir().toUpperCase()) && os.tmpdir() !== os.tmpdir().toUpperCase()

/** Every row: a clean baseline call, the write, then a deny naming a file and a refused relaunch. */
async function expectCaught(script: string, file: RegExp): Promise<void> {
  const wired = setup()
  expect(await wired.hook()).toBeUndefined()

  wired.bash(script)

  const denial = await wired.hook()
  expect(denial).toMatch(/quarantined/)
  expect(denial).toMatch(file)
  expect(await wired.relaunch()).toMatch(/this launch is quarantined/)
  expect(wired.notices()).toHaveLength(1)
}

const LAUNCH_FILE = /\/agents\/ag00000[12]\/(settings\.json|mcp\.json|plan\.json|relaunch)/
const ZSHRC = /\/home\/\.zshrc changed/

describe('a launch written through the broker, then a clean tool call', () => {
  it('allows the call, its relaunch, and files no notice', async () => {
    const wired = setup()

    const first = await wired.hook()
    const second = await wired.hook()

    expect([first, second]).toEqual([undefined, undefined])
    expect(await wired.relaunch()).toBeUndefined()
    expect(wired.notices()).toEqual([])
  })

  it('denies a nonce the broker did not mint', async () => {
    const wired = setup()

    expect(await wired.hook('f'.repeat(64))).toMatch(/integrity check refused: no baseline/)
  })
})

describe('Bash writes to a launch file (S1-S8, S14, S17)', () => {
  it.each([
    ['S1 redirect', `echo '{}' > "$A/settings.json"`],
    ['S1 sed -i', `sed -i.bak 's/pretool/xx/' "$A/settings.json"`],
    ['S1 rm', `rm "$A/settings.json"`],
    ['S1 mv over', `printf x > "$T/x" && mv "$T/x" "$A/settings.json"`],
    ['S2 ~ spelling', `echo x >> ~/.agent-chat/agents/${AGENT}/settings.json`],
    ['S2 $HOME spelling', `echo x >> "$HOME/.agent-chat/agents/${AGENT}/mcp.json"`],
    ['S3 // ./ .. spelling', `echo x >> "$AC//agents/./${SIBLING}/../${AGENT}/plan.json"`],
    ['S4 rm -r the agent dir', `rm -r "$A"`],
    ['S4 rm -rf the agents dir', `rm -rf "$AC/agents"`],
    ['S4 mv the agents dir', `mv "$AC/agents" "$T/moved"`],
    ['S5 cd, then a relative path', `cd "$AC/agents" && echo x >> ${AGENT}/relaunch`],
    ['S6 glob', `echo x >> "$AC"/agents/ag0000?1/settings.json`],
    ['S6 quote split', `echo x >> "$AC"/agents/ag0000''01/settings.json`],
    ['S7 symlinked parent', `ln -s "$AC" "$T/x" && echo x >> "$T/x/agents/${AGENT}/settings.json"`],
    ['S8 find -delete', `find "$AC" -name settings.json -delete`],
    ['S14 hard link, then a write to it', `ln "$A/settings.json" "$T/h" && echo x >> "$T/h"`],
    ['S17 a dir in place of the file', `rm "$A/settings.json" && mkdir "$A/settings.json"`],
  ])('%s is caught at the next call', async (_shape, script) => {
    await expectCaught(script, LAUNCH_FILE)
  })

  it.runIf(caseInsensitiveTmp)('S10 a case variant of the directory is caught at the next call', async () => {
    await expectCaught(`echo x >> "$AC/AGENTS/${AGENT}/settings.json"`, LAUNCH_FILE)
  })

  it.skipIf(isRoot)('S17 chmod 000 is caught at the next call', async () => {
    await expectCaught(`chmod 000 "$A/settings.json"`, LAUNCH_FILE)
  })
})

describe('writes to the launch files that are not settings.json (S9, S11-S13)', () => {
  it.each([
    ['S9 through a symlink to plan.json', `ln -s "$A/plan.json" "$T/p" && echo x >> "$T/p"`],
    [
      'S11 plan.json with --settings /dev/null',
      `printf '{"args":["--settings","/dev/null"]}' > "$A/plan.json"`,
    ],
    ['S12 the relaunch script', `printf '#!/bin/sh\\nexec claude\\n' > "$A/relaunch"`],
    ['S13 mcp.json', `echo '{}' > "$A/mcp.json"`],
  ])('%s is caught at the next call, and run-agent will not start it', async (_shape, script) => {
    await expectCaught(script, LAUNCH_FILE)
  })

  it('S11 refuses the relaunch even before any tool call reports', async () => {
    const wired = setup()

    wired.bash(`printf '{"args":["--settings","/dev/null"]}' > "$A/plan.json"`)

    expect(await wired.relaunch()).toMatch(/plan\.json changed \(sha256\)/)
    expect(await wired.hook()).toMatch(/quarantined/)
  })
})

describe('FIFO and /dev/zero swaps, which must deny without blocking', () => {
  it.each([
    ['a FIFO for settings.json', `rm "$A/settings.json" && mkfifo "$A/settings.json"`, LAUNCH_FILE],
    ['/dev/zero for settings.json', `ln -sf /dev/zero "$A/settings.json"`, LAUNCH_FILE],
    ['a FIFO for .zshrc', `rm ~/.zshrc && mkfifo ~/.zshrc`, ZSHRC],
    ['/dev/zero for .zshrc', `ln -sf /dev/zero ~/.zshrc`, ZSHRC],
  ])('%s is caught', { timeout: 5_000 }, async (_shape, script, file) => {
    await expectCaught(script, file)
  })
})

describe('the files a later shell sources', () => {
  it.each([
    ['an appended .zshrc', `echo 'alias ls=rm' >> ~/.zshrc`, ZSHRC],
    [
      'a .zshrc restored to its bytes and mtime',
      `cp -p ~/.zshrc "$T/z" && echo x >> ~/.zshrc && cp -p "$T/z" ~/.zshrc`,
      ZSHRC,
    ],
    ['a new .zshenv', `echo 'export X=1' > ~/.zshenv`, /\.zshenv changed \(state\)/],
    [
      'a rewritten session snapshot',
      `echo x >> ~/.claude/shell-snapshots/snapshot-zsh-1.sh`,
      /snapshot-zsh-1\.sh changed/,
    ],
  ])('%s is caught', async (_shape, script, file) => {
    await expectCaught(script, file)
  })
})

describe('S15 edit-then-restore of a launch file between two calls', () => {
  // Known gap, kept a TP-4256 follow-up: the watch keeps no ctime, so a same-inode restore passes.
  it('is not caught yet', async () => {
    const wired = setup()
    expect(await wired.hook()).toBeUndefined()

    wired.bash(`cp "$A/settings.json" "$T/s" && echo x >> "$A/settings.json" && cp "$T/s" "$A/settings.json"`)

    expect(await wired.hook()).toBeUndefined()
  })
})

describe('a resume after a quarantine', () => {
  it('runs under a new nonce with a fresh baseline, while the old nonce still denies', async () => {
    const wired = setup()
    await wired.hook()
    wired.bash(`echo x >> "$A/mcp.json"`)
    expect(await wired.hook()).toMatch(/quarantined/)

    const resumed = wired.launch(AGENT)

    expect(resumed).not.toBe(wired.nonce)
    expect(await wired.hook(resumed)).toBeUndefined()
    expect(await wired.relaunch()).toBeUndefined()
    expect(await wired.hook()).toMatch(/quarantined/)
  })
})
