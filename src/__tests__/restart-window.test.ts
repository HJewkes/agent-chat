import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/restart-window.sh')
const SCHEMA = `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  actor TEXT NOT NULL, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT);`

const shim = (body: string): string => `#!/usr/bin/env bash\n${body}\n`

const SHIMS: Record<string, string> = {
  pgrep: shim('[ -n "${FAKE_PGREP:-}" ] && { echo "$FAKE_PGREP" | tr , "\\n"; exit 0; }; exit 1'),
  npm: shim('echo "npm $*" >> "$SHIM_LOG"'),
  'agent-chat-real': shim(`
echo "agent-chat $*" >> "$SHIM_LOG"
case "$1 $2" in
  "service restart")
    if [ -n "\${FAKE_RESTART_FAIL:-}" ]; then echo "$FAKE_RESTART_FAIL" >&2; exit 1; fi
    now=$(( $(date +%s) * 1000 + 5000 ))
    for ((i = 0; i < \${FAKE_STARTED:-1}; i++)); do
      sqlite3 "$RESTART_WINDOW_DB" "INSERT INTO events(ts,kind,actor) VALUES ($now,'broker_started','broker')"
    done
    for ((i = 0; i < \${FAKE_SHADOW_ERRORS:-0}; i++)); do
      sqlite3 "$RESTART_WINDOW_DB" "INSERT INTO events(ts,kind,actor) VALUES ($now,'ledger_shadow_error','broker')"
    done ;;
  "agent ls")
    [ -z "\${FAKE_LS_FAIL:-}" ] || exit 1
    echo "\${FAKE_LS_OUT:-[]}" ;;
esac`),
}

let dir: string
let repo: string
let db: string
let log: string

const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-window-')))
  repo = path.join(dir, 'checkout')
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.invalid')
  git('config', 'user.name', 't')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const [name, body] of Object.entries(SHIMS)) {
    const dest = name === 'agent-chat-real' ? path.join(repo, 'bin', 'agent-chat') : path.join(bin, name)
    fs.writeFileSync(dest, body, { mode: 0o755 })
  }
  fs.symlinkSync(path.join(repo, 'bin', 'agent-chat'), path.join(bin, 'agent-chat'))
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  db = path.join(dir, 'events.db')
  execFileSync('sqlite3', [db, SCHEMA])
  log = path.join(dir, 'shim.log')
  fs.writeFileSync(log, '')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const run = (env: Record<string, string> = {}, args: string[] = []) => {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      RESTART_WINDOW_DB: db,
      SHIM_LOG: log,
      ...env,
    },
  })
  return { code: result.status, out: result.stdout, err: result.stderr, calls: fs.readFileSync(log, 'utf8') }
}

describe('restart-window pre-checks', () => {
  it('refuses with the guard message when the restart refuses on an open ask', () => {
    const r = run({ FAKE_RESTART_FAIL: 'refusing to restart: unanswered ask from alice' })

    expect(r.code).toBe(1)
    expect(r.err).toContain('unanswered ask from alice')
    expect(r.calls).not.toContain('npm')
  })

  it('refuses and names the pids when a git push is running', () => {
    const r = run({ FAKE_PGREP: '4242,4243' })

    expect(r.code).toBe(1)
    expect(r.err).toContain('4242,4243')
    expect(r.calls).not.toContain('service restart')
  })

  it('refuses when the installed checkout is on another branch', () => {
    git('checkout', '-q', '-b', 'feature')
    const r = run()

    expect(r.code).toBe(1)
    expect(r.err).toContain("'feature', not main")
    expect(r.calls).not.toContain('service restart')
  })

  it('refuses when the installed checkout is dirty', () => {
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'x')
    const r = run()

    expect(r.code).toBe(1)
    expect(r.err).toContain('uncommitted changes')
    expect(r.calls).not.toContain('service restart')
  })

  it('rejects any argument, including --force', () => {
    const r = run({}, ['--force'])

    expect(r.code).toBe(1)
    expect(r.calls).toBe('')
  })
})

describe('restart-window post-checks', () => {
  it('prints OK and rebuilds the checkout after a clean restart', () => {
    const r = run()

    expect(r.code).toBe(0)
    expect(r.out).toContain('restart-window OK')
    expect(r.calls).toContain('npm ci')
    expect(r.calls).toContain('npm run build')
  })

  it.each([
    ['no broker_started row', { FAKE_STARTED: '0' }, 'exactly one broker_started'],
    ['two broker_started rows', { FAKE_STARTED: '2' }, 'exactly one broker_started'],
    ['a ledger_shadow_error row', { FAKE_SHADOW_ERRORS: '1' }, 'no ledger_shadow_error'],
    ['agent ls exiting non-zero', { FAKE_LS_FAIL: '1' }, 'agent ls --json parses'],
    ['agent ls printing non-JSON', { FAKE_LS_OUT: 'not json' }, 'agent ls --json parses'],
  ])('exits 2 on %s', (_name, env, line) => {
    const r = run(env)

    expect(r.code).toBe(2)
    expect(r.out).toContain(`FAIL: ${line}`)
    expect(r.out).not.toContain('restart-window OK')
  })

  it('ignores events from before the restart', () => {
    execFileSync('sqlite3', [
      db,
      "INSERT INTO events(ts,kind,actor) VALUES (1000,'broker_started','broker'),(1000,'ledger_shadow_error','broker')",
    ])
    const r = run()

    expect(r.code).toBe(0)
  })
})
