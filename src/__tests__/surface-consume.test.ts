import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { itermIdentity, oscTitle, parseHex } from '@titan-design/agent-surface'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeLaunchFiles } from '../agents/launch-files.js'
import { relaunchScriptPath } from '../agents/launcher.js'
import type { LaunchPlan } from '../agents/types.js'

/** TP-639: the launch surfaces come from @titan-design/agent-surface, wired here by the host's own options. */

const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')
const AGENT_ID = 'ag000001'

let dir: string
let fakeClaude: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-surface-consume-'))
  fakeClaude = path.join(dir, 'fake-claude.js')
  fs.writeFileSync(fakeClaude, "process.stdout.write('fake-claude-ran')\n")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const plan = (over: Partial<LaunchPlan> = {}): LaunchPlan => ({
  agentId: AGENT_ID,
  bin: 'claude',
  args: [fakeClaude],
  cwd: dir,
  env: {},
  title: 'zz-task-1',
  surface: 'headless',
  ...over,
})

const writePlan = (value: LaunchPlan): void => {
  const agentDir = path.join(dir, 'agents', AGENT_ID)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'plan.json'), JSON.stringify(value))
}

const launchEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: '/usr/bin:/bin',
  AGENT_CHAT_HOME: dir,
  AGENT_CHAT_ACTIVE_WORK_ROOT: path.join(dir, 'aw'),
  AGENT_CHAT_CLAUDE: process.execPath,
  ...extra,
})

const runVerb = (extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, 'run-agent', AGENT_ID], { encoding: 'utf8', env: launchEnv(extra) })

describe('the launched agent takes the scrubbed environment, not the launcher’s', () => {
  it('drops a credential the launching shell exported', () => {
    fs.writeFileSync(
      fakeClaude,
      'process.stdout.write(JSON.stringify([process.env.NPM_TOKEN, process.env.AGENT_CHAT_NAME]))\n',
    )
    writePlan(plan({ env: { AGENT_CHAT_NAME: 'scout' } }))

    const result = runVerb({ NPM_TOKEN: 'leaked' })

    expect(JSON.parse(result.stdout)).toEqual([null, 'scout'])
  })
})

describe('a visible pane keeps its identity', () => {
  const ITERM = { TERM_PROGRAM: 'iTerm.app' }

  it('wears the colour configured for its seat', () => {
    const autonomy = path.join(dir, 'aw', 'claude-channels', 'sources', 'autonomy')
    fs.mkdirSync(path.join(autonomy, 'seats'), { recursive: true })
    fs.writeFileSync(path.join(autonomy, 'charter.md'), '---\nseats: [alpha-coord]\n---\n')
    fs.writeFileSync(path.join(autonomy, 'seats', 'alpha-coord.md'), '---\nprefix: ac\n---\n')
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ paneColours: { seats: { 'alpha-coord': '#123456' } } }),
    )
    writePlan(plan({ surface: 'iterm-tab', title: 'ac-task-1' }))

    const rgb = parseHex('#123456')
    expect(rgb).toBeDefined()
    expect(runVerb(ITERM).stdout).toBe(
      `${oscTitle('ac-task-1')}${itermIdentity('ac-task-1', rgb!)}fake-claude-ran`,
    )
  })

  it('wears the colour configured for its profile when no seat claims it', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ paneColours: { profiles: { reviewer: '#00ff00' } } }),
    )
    writePlan(plan({ surface: 'iterm-tab', env: { AGENT_CHAT_PROFILE: 'reviewer' } }))

    const rgb = parseHex('#00ff00')
    expect(runVerb(ITERM).stdout).toBe(
      `${oscTitle('zz-task-1')}${itermIdentity('zz-task-1', rgb!)}fake-claude-ran`,
    )
  })
})

describe('a relaunch script stored before the swap', () => {
  /** Byte for byte the script `relaunchScript` wrote before `agents/surfaces/` was deleted. */
  const storedScript = (agentId: string, home: string): string =>
    [
      '#!/bin/sh',
      'if [ "$#" -ne 0 ]; then',
      `  echo "agent-chat: not relaunching ${agentId}: typed keys joined the command (extra arguments: $*)" >&2`,
      '  exit 64',
      'fi',
      `export AGENT_CHAT_HOME='${home}'`,
      `exec '${process.execPath}' '${CLI}' 'run-agent' '${agentId}'`,
      '',
    ].join('\n')

  const runScript = (script: string) => {
    const file = path.join(dir, 'relaunch-old')
    fs.writeFileSync(file, script, { mode: 0o700 })
    return spawnSync('/bin/sh', [file], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', AGENT_CHAT_CLAUDE: process.execPath },
    })
  }

  it('still starts the agent through the run-agent verb', () => {
    writePlan(plan())

    const result = runScript(storedScript(AGENT_ID, dir))

    expect(result.stdout).toBe('fake-claude-ran')
    expect(result.status).toBe(0)
  })

  it('is what a new launch writes too, so old and new scripts are interchangeable', () => {
    process.env.AGENT_CHAT_HOME = dir
    try {
      writeLaunchFiles(plan(), {})
      const written = fs.readFileSync(relaunchScriptPath(AGENT_ID), 'utf8')

      expect(written).toContain(`'run-agent' '${AGENT_ID}'`)
      expect(written).toContain(`export AGENT_CHAT_HOME='${dir}'`)
    } finally {
      delete process.env.AGENT_CHAT_HOME
    }
  })
})
