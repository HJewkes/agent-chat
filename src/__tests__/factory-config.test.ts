import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** CC-1148: scripts/seat/factory-config keeps deployment values in a local git store, never in this repo. */

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/seat/factory-config')
const KEYS = [
  'ACTIVE_ROOT',
  'AUTONOMY_ROOT',
  'AGENT_CHAT_HOME',
  'COORDINATORS',
  'SEAT_SCRIPTS',
  'TITAN_FACTORY_DB',
]

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

let home: string
let store: string

function neutralValues(): Record<string, string> {
  return {
    ACTIVE_ROOT: path.join(home, 'Application Support', 'active-work'),
    AUTONOMY_ROOT: path.join(home, 'autonomy'),
    AGENT_CHAT_HOME: path.join(home, '.agent-chat'),
    COORDINATORS: 'seat-test-a seat-test-b',
    SEAT_SCRIPTS: path.join(home, 'seat'),
    TITAN_FACTORY_DB: path.join(home, 'factory.sqlite3'),
  }
}

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TITAN_FACTORY_CONFIG_DIR: store }
  for (const key of [...KEYS, 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_DIR', 'GIT_WORK_TREE'])
    delete env[key]
  return env
}

function factoryConfig(args: string[], extraEnv: Record<string, string> = {}): Run {
  const run = spawnSync('sh', [SCRIPT, ...args], { env: { ...baseEnv(), ...extraEnv }, encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function git(...args: string[]): string {
  const run = spawnSync('git', ['-C', store, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    env: baseEnv(),
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

function initStore(): void {
  const run = factoryConfig(['init'], neutralValues())
  expect(run.status, run.stderr).toBe(0)
}

function seatEnv(): string {
  return fs.readFileSync(path.join(store, 'seat.env'), 'utf8')
}

/** Rewrites seat.env and commits it with a changelog line, so only the value itself can fail check. */
function commitLoggedEdit(next: string): void {
  fs.writeFileSync(path.join(store, 'seat.env'), next)
  fs.appendFileSync(path.join(store, 'CHANGELOG.md'), '- test edit\n')
  git('commit', '-qam', 'edit')
}

function replaceLine(key: string, line: string): string {
  return seatEnv().replace(new RegExp(`^${key}=.*$`, 'm'), line)
}

function expectCheckFails(reason: RegExp): void {
  const run = factoryConfig(['check'])
  expect(run.status, run.stdout).toBe(1)
  expect(run.stderr).toMatch(reason)
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-config-'))
  store = path.join(home, 'store')
})

afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

describe('factory-config init', () => {
  it('creates a local store with one commit, no remote and a dated changelog that check passes', () => {
    initStore()

    expect(factoryConfig(['check']).status).toBe(0)
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1)
    expect(git('remote').trim()).toBe('')
    expect(fs.readFileSync(path.join(store, 'CHANGELOG.md'), 'utf8')).toMatch(/^## \d{4}-\d{2}-\d{2}$/m)
  })

  it('refuses when a value is unset, naming the key', () => {
    const values = neutralValues()
    delete (values as Partial<typeof values>).SEAT_SCRIPTS

    const run = factoryConfig(['init'], values)

    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/SEAT_SCRIPTS is unset/)
    expect(fs.existsSync(path.join(store, 'seat.env'))).toBe(false)
  })

  it('refuses to overwrite an existing seat.env', () => {
    initStore()
    const before = seatEnv()

    const run = factoryConfig(['init'], { ...neutralValues(), AUTONOMY_ROOT: path.join(home, 'other') })

    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/seat\.env exists/)
    expect(seatEnv()).toBe(before)
  })

  it('prints the store dir for path', () => {
    expect(factoryConfig(['path']).stdout.trim()).toBe(store)
  })
})

describe('factory-config seat.env format', () => {
  it('keeps a value with a space unchanged when sourced by sh', () => {
    initStore()

    const run = spawnSync(
      'sh',
      ['-c', 'set -a; . "$1"; printf %s "$ACTIVE_ROOT"', 'sh', path.join(store, 'seat.env')],
      {
        encoding: 'utf8',
      },
    )

    expect(run.stdout).toBe(neutralValues().ACTIVE_ROOT)
  })
})

describe('factory-config check', () => {
  it.each(KEYS)('fails naming %s when it is removed', key => {
    initStore()
    commitLoggedEdit(replaceLine(key, ''))

    expectCheckFails(new RegExp(`missing ${key}`))
  })

  it.each(['seat-test://x', '/srv/x.ts.net/y', '/srv/http-cache', `/srv/${os.hostname()}/x`])(
    'fails on a host or URL literal in %s',
    literal => {
      initStore()
      commitLoggedEdit(replaceLine('AUTONOMY_ROOT', `AUTONOMY_ROOT=${literal}`))

      expectCheckFails(/AUTONOMY_ROOT holds a hostname or URL literal/)
    },
  )

  it('fails on a relative path', () => {
    initStore()
    commitLoggedEdit(replaceLine('SEAT_SCRIPTS', 'SEAT_SCRIPTS=seat'))

    expectCheckFails(/SEAT_SCRIPTS is not an absolute path/)
  })

  it.each([
    ['an export prefix', 'export AGENT_CHAT_HOME=/srv/ac', /not KEY=VALUE/],
    ['a dollar sign', 'AGENT_CHAT_HOME=/srv/$USER', /AGENT_CHAT_HOME holds \$/],
    ['a backtick', 'AGENT_CHAT_HOME=/srv/`id`', /AGENT_CHAT_HOME holds \$/],
    ['a single-quoted value', "AGENT_CHAT_HOME='/srv/ac'", /AGENT_CHAT_HOME is quoted wrongly/],
  ])('fails on %s', (_name, line, reason) => {
    initStore()
    commitLoggedEdit(replaceLine('AGENT_CHAT_HOME', line))

    expectCheckFails(reason)
  })

  it('fails when seat.env was committed without a changelog entry', () => {
    initStore()
    fs.writeFileSync(
      path.join(store, 'seat.env'),
      replaceLine('AUTONOMY_ROOT', `AUTONOMY_ROOT=${home}/moved`),
    )
    git('commit', '-qam', 'unlogged edit')

    expectCheckFails(/changed seat\.env without a CHANGELOG\.md entry/)
  })

  it('fails when the store worktree is dirty', () => {
    initStore()
    fs.writeFileSync(
      path.join(store, 'seat.env'),
      replaceLine('AUTONOMY_ROOT', `AUTONOMY_ROOT=${home}/moved`),
    )

    expectCheckFails(/worktree is dirty/)
  })
})
