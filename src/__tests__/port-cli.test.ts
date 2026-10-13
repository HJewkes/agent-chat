import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PortEnvelope } from '../cli/port.js'
import { SpawnPortOutput } from '../cli/verbs/port-agent.js'
import { QueuePortOutput } from '../cli/verbs/port-queue.js'
import { FilesClaimsPortOutput, InboxSincePortOutput, RosterPortOutput } from '../cli/verbs/port-reads.js'
import { SendPortOutput } from '../cli/verbs/port-send.js'

const cli = path.resolve(import.meta.dirname, '../../dist/cli.js')
const VERBS = ['roster', 'inbox-since', 'queue', 'files-claims', 'spawn', 'retire', 'resume', 'send']

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'port-cli-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function runCli(args: string[], input = '') {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, AGENT_CHAT_HOME: home },
    timeout: 30_000,
  })
}

describe('agent-chat port, run from dist', () => {
  it('lists all eight verbs in port --help', () => {
    const { stdout, status } = runCli(['port', '--help'])

    expect(status).toBe(0)
    for (const verb of VERBS) expect(stdout).toMatch(new RegExp(`^\\s+${verb}\\b`, 'm'))
  })

  it('exits 69 with broker_unavailable and starts no broker when none is listening', () => {
    const { stdout, status } = runCli(['port', 'roster'])

    const envelope = PortEnvelope.parse(JSON.parse(stdout.trim()))
    expect(status).toBe(69)
    expect(envelope).toMatchObject({ ok: false, error: { code: 'broker_unavailable' } })
    expect(existsSync(path.join(home, 'chat.sock'))).toBe(false)
    expect(readdirSync(home)).toEqual([])
  })
})

describe('port stdin switches, run from dist', () => {
  it.each([
    [
      ['port', 'spawn', '--frame-stdin'],
      JSON.stringify({
        t: 'spawn',
        name: 'worker',
        profile: 'implementer',
        brief: 'do it',
        cwd: '/work/tree',
        configDir: '/cfg',
        surface: 'headless',
        briefing: '',
        tags: [],
        task: 'T-1',
        spawnedAs: 'burndown',
      }),
    ],
    [['port', 'resume', 'worker', '--message-stdin'], 'wake up'],
  ])('%j parses as a bare switch and reaches the broker check', (args, input) => {
    const { stdout, status } = runCli(args, input)

    const envelope = PortEnvelope.parse(JSON.parse(stdout.trim()))
    expect(status).toBe(69)
    expect(envelope).toMatchObject({ ok: false, error: { code: 'broker_unavailable' } })
  })
})

describe('port output schemas', () => {
  it('match the committed JSON schema snapshot', async () => {
    const schemas = {
      roster: RosterPortOutput,
      'inbox-since': InboxSincePortOutput,
      queue: QueuePortOutput,
      'files-claims': FilesClaimsPortOutput,
      spawn: SpawnPortOutput,
      send: SendPortOutput,
      envelope: PortEnvelope,
    }
    const json = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'output' })]),
    )

    await expect(`${JSON.stringify(json, null, 2)}\n`).toMatchFileSnapshot('./golden/port-schemas.json')
  })
})
