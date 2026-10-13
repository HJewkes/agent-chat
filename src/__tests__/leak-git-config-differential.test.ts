import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { keyValue, readConfigCall, type ConfigReading } from '../leak-guard/git-programs.js'
import { findRealGit } from '../leak-guard/git-shim.js'
import { HOST_PATH } from './helpers/git-shim-fixture.js'

/**
 * CC-1137 a: the guard's reading of a `git config` call, and of a `-c` / `--config-env` word,
 * checked against what real git writes. Each row runs in its own scratch repo with no global or
 * system config and no inherited `GIT_*` variable, so an agent's hooks-path `-c` cannot leak in.
 */
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-config-diff-')))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))
const realGit = findRealGit(HOST_PATH, path.join(scratch, 'none')) as string
const VERSION = execFileSync(realGit, ['--version'], { encoding: 'utf8' }).trim()
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(VERSION) ?? []).slice(1).map(Number)
// `git config set/get/list/unset/rename-section` subcommands arrived in git 2.46.
const HAS_SUBCOMMANDS = major > 2 || (major === 2 && minor >= 46)

const ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  PATH: HOST_PATH,
  HOME: scratch,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  E: 'from-env',
}

interface Entry {
  key: string
  value: string | null
}

let count = 0
const runGit = (cwd: string, args: readonly string[]): string =>
  spawnSync(realGit, args, { cwd, env: ENV, encoding: 'utf8' }).stdout

/** A fresh repo with `seed` pairs set in its local config. */
function repo(seed: readonly (readonly [string, string])[] = []): string {
  const dir = path.join(scratch, `row-${++count}`)
  fs.mkdirSync(dir)
  runGit(dir, ['init', '-q'])
  for (const [key, value] of seed) runGit(dir, ['config', key, value])
  return dir
}

/** git's `--list --null` records: `key\nvalue`, or a bare `key` for a key set with no value. */
const parseEntry = (record: string): Entry => {
  const nl = record.indexOf('\n')
  return nl < 0 ? { key: record, value: null } : { key: record.slice(0, nl), value: record.slice(nl + 1) }
}

/** Every entry of the repo's config and of a `config` file beside it, as git lists them. */
function entries(cwd: string): Entry[] {
  return ['.git/config', 'config'].flatMap(file =>
    fs.existsSync(path.join(cwd, file))
      ? runGit(cwd, ['config', '--file', file, '--list', '--null'])
          .split('\0')
          .filter(r => r !== '')
          .map(parseEntry)
      : [],
  )
}

/** The entries of `a` not in `b`, counting repeats. */
function minus(a: readonly Entry[], b: readonly Entry[]): Entry[] {
  const left = [...b]
  return a.filter(entry => {
    const at = left.findIndex(o => o.key === entry.key && o.value === entry.value)
    if (at < 0) return true
    left.splice(at, 1)
    return false
  })
}

/** What `git config <args>` adds and removes, its exit status ignored: the diff is the oracle. */
function gitDiff(args: readonly string[], seed: readonly (readonly [string, string])[] = []) {
  const cwd = repo(seed)
  const before = entries(cwd)
  runGit(cwd, ['config', ...args])
  const after = entries(cwd)
  return { added: minus(after, before), removed: minus(before, after) }
}

/** A section name as git compares it: the section lower-cased, a subsection exact. */
function canonSection(name: string): string {
  const dot = name.indexOf('.')
  return dot < 0 ? name.toLowerCase() : `${name.slice(0, dot).toLowerCase()}${name.slice(dot)}`
}

/** A key as git compares it: section and name lower-cased, a subsection exact. */
function canonKey(key: string): string {
  const last = key.lastIndexOf('.')
  return `${canonSection(key.slice(0, last))}.${key.slice(last + 1).toLowerCase()}`
}

const sectionOf = (key: string): string => canonSection(key.slice(0, key.lastIndexOf('.')))
const read = (args: readonly string[]): ConfigReading => readConfigCall({ resolved: args, written: args })

/** Assert the guard reads a set of git's one added entry: key always, value when `typed` is false. */
function expectSet(args: readonly string[], typed = false): void {
  const reading = read(args)
  const { added } = gitDiff(args)
  expect(added, `${VERSION}: git config ${args.join(' ')}`).toHaveLength(1)
  const [entry] = added as [Entry]
  expect(reading.mode).toBe('set')
  if (reading.mode !== 'set') return
  expect(canonKey(reading.key ?? '')).toBe(canonKey(entry.key))
  if (!typed) expect(reading.value).toBe(entry.value)
}

describe('git config set rows: the guard reads the key and value git writes (CC-1137 a)', () => {
  it('runs with no command-scope config inherited from the agent env', () => {
    const cwd = repo()
    const scopes = runGit(cwd, ['config', '--list', '--show-scope', '--null']).split('\0')
    expect(scopes.filter((_, i) => i % 2 === 0)).not.toContain('command')
  })

  it.each([
    [['protocol.ext.allow', 'always']],
    [['Protocol.Ext.ALLOW', 'always']],
    [['--add', 'protocol.allow', 'always']],
    [['--replace-all', 'k.x', 'v']],
    [['--file', 'config', 'k.x', 'v']],
    [['--fil=config', 'k.x', 'v']],
    [['-zf', 'config', 'k.x', 'v']],
    [['--no-file', 'k.x', 'v']],
    [['protocol.ext.allow', 'always', '--get']],
    [['--', 'protocol.allow', 'always']],
    [['Remote.Origin.URL', 'ext::sh -c x']],
    [['url.ext::sh.insteadOf', 'https://x']],
  ])('legacy %j', args => expectSet(args))

  it.skipIf(!HAS_SUBCOMMANDS).each([
    [['set', 'protocol.allow', 'always']],
    [['set', '--append', 'k.x', 'v']],
    [['set', '--', 'k.x', 'v']],
    [['set', '--comment', 'c', 'k.x', 'v']],
    // git's subcommand form stops at its first positional, so these values are words, not options.
    [['set', 'protocol.ext.allow', '--no-comment']],
    [['set', 'remote.o.url', '--fixed-value']],
    [['set', '--', 'k.z', '--global']],
  ])('subcommand %j', args => expectSet(args))

  it.each([[['--type=bool', 'k.x', 'yes']], [['--bool', 'k.x', 'on']], [['--int', 'k.x', '1k']]])(
    'typed %j: the key matches, git normalises the value',
    args => expectSet(args, true),
  )
})

describe('git config rename rows: the guard reads the sections git renames (CC-1137 a)', () => {
  const SEED = [
    ['a.k', '1'],
    ['a.b.k', '1'],
  ] as const

  const rows: string[][] = [
    ['--rename-section', 'a', 'protocol'],
    ['--ren', 'a.b', 'protocol.ext'],
    // Legacy git reads past a leading `--`.
    ['--', '--rename-section', 'a', 'protocol'],
    ...(HAS_SUBCOMMANDS ? [['rename-section', 'a', 'remote.o']] : []),
  ]
  it.each(rows.map(r => [r]))('%j', args => {
    const reading = read(args)
    const { added, removed } = gitDiff(args, SEED)
    expect(reading).toMatchObject({ mode: 'rename' })
    if (reading.mode !== 'rename') return
    const [from, to] = reading.names
    expect(removed.length, `${VERSION}: git config ${args.join(' ')}`).toBeGreaterThan(0)
    expect(new Set(removed.map(e => sectionOf(e.key)))).toEqual(new Set([canonSection(from ?? '')]))
    expect(new Set(added.map(e => sectionOf(e.key)))).toEqual(new Set([canonSection(to ?? '')]))
  })
})

describe('git config non-write rows: git adds nothing exactly where the guard reads other (CC-1137 a)', () => {
  const rows: string[][] = [
    ['--get', 'k.x'],
    ['--unset', 'k.x'],
    ['k.x'],
    ['--get-regexp', 'k'],
    ['-l'],
    ['--remove-section', 'k'],
    ...(HAS_SUBCOMMANDS ? [['get', 'k.x'], ['list'], ['unset', 'k.x']] : []),
  ]
  it.each(rows.map(r => [r]))('%j', args => {
    const { added } = gitDiff(args, [['k.x', 'v']])
    expect(added).toEqual([])
    expect(read(args).mode).toBe('other')
  })
})

describe('git config rows the guard fails closed on (CC-1137 a)', () => {
  it.each([[['--re', 'k.x', 'v']], [['--frob', 'k.x', 'v']]])('%j reads as option', args => {
    expect(read(args).mode).toBe('option')
  })

  // Accepted: git refuses these, the guard reads a set, which can only over-deny.
  it
    .skipIf(!HAS_SUBCOMMANDS)
    .each([[['set', 'k.x', 'v', '--file', 'config']], [['--file', 'config', 'set', 'k.x', 'v']]])(
    '%j reads as a set git refuses',
    args => {
      expect(gitDiff(args).added).toEqual([])
      expect(read(args).mode).toBe('set')
    },
  )
})

describe('-c and --config-env words: keyValue matches the entry git adds (CC-1137 a)', () => {
  /** git's command-scope entries for one option word. */
  function commandEntries(option: readonly string[]): Entry[] {
    const records = runGit(repo(), [...option, 'config', '--list', '--show-scope', '--null']).split('\0')
    const out: Entry[] = []
    for (let i = 0; i + 1 < records.length; i += 2)
      if (records[i] === 'command') out.push(parseEntry(records[i + 1] as string))
    return out
  }

  it.each([
    [['-c', 'k.x=v'], 'k.x=v', false],
    [['-c', 'k.x'], 'k.x', false],
    [['-c', 'a.b.c=x=y'], 'a.b.c=x=y', false],
    [['-c', 'Sec.Sub.Name=v'], 'Sec.Sub.Name=v', false],
    [['--config-env=url.x=y.insteadOf=E'], 'url.x=y.insteadOf=E', true],
    [['--config-env', 'protocol.allow=E'], 'protocol.allow=E', true],
  ])('%j', (option, word, fromEnv) => {
    const pair = keyValue({ resolved: word, marked: word, fromEnv })
    const [entry, ...rest] = commandEntries(option)
    expect(rest, VERSION).toEqual([])
    expect(pair).toBeDefined()
    expect(canonKey(pair?.key ?? '')).toBe(canonKey(entry?.key ?? ''))
    // undefined is a value the guard does not read, as for `--config-env`; null is git's bare `-c key`.
    if (pair?.value !== undefined) expect(pair.value).toBe(entry?.value)
    else expect(fromEnv).toBe(true)
  })
})
