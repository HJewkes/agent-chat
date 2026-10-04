import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/restart-window.sh')

const shim = (body: string): string => `#!/usr/bin/env bash\n${body}\n`

const SHIMS: Record<string, string> = {
  pgrep: shim(`
case "$*" in
  *push*) pids="\${FAKE_PGREP_PUSH:-}" ;;
  *) pids="\${FAKE_PGREP_MERGE:-}" ;;
esac
[ -n "$pids" ] && { echo "$pids" | tr , "\\n"; exit 0; }
exit 1`),
  npm: shim(`
echo "npm $*" >> "$SHIM_LOG"
echo "cwd $PWD" >> "$SHIM_CWD_LOG"
[ "$*" != "\${FAKE_NPM_FAIL:-}" ] || exit 1
[ "$*" != "ci" ] || { mkdir -p node_modules; echo new > node_modules/marker; }
[ "$*" != "run build" ] || { mkdir -p dist; echo new > dist/marker; }`),
  rm: shim(`
/bin/rm "$@" || exit
for live in node_modules dist; do
  [ -e "$SHIM_REPO/$live" ] || echo "$live absent after rm $*" >> "$SHIM_GAP_LOG"
done`),
  'agent-chat-real': shim(`
echo "agent-chat $*" >> "$SHIM_LOG"
case "$1 $2" in
  "service restart")
    echo "$(cat "$SHIM_REPO/dist/marker")" >> "$SHIM_DIST_LOG"
    if [ -n "\${FAKE_RESTART_FAIL:-}" ]; then echo "$FAKE_RESTART_FAIL" >&2; exit 1; fi
    if [ -n "\${FAKE_RESTART_FAIL_ONCE:-}" ] && [ ! -e "$AGENT_CHAT_HOME/failed-once" ]; then
      touch "$AGENT_CHAT_HOME/failed-once"
      [ -z "\${FAKE_EDIT_TRACKED:-}" ] || echo edited > "$SHIM_REPO/$FAKE_EDIT_TRACKED"
      echo "$FAKE_RESTART_FAIL_ONCE" >&2; exit 1
    fi
    now=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
    for ((i = 0; i < \${FAKE_STARTED:-1}; i++)); do
      echo "{\\"ts\\":\\"$now\\",\\"event\\":\\"broker_started\\"}" >> "$AGENT_CHAT_HOME/broker.log\${FAKE_LOG_SUFFIX:-}"
    done
    for ((i = 0; i < \${FAKE_SHADOW_ERRORS:-0}; i++)); do
      echo "{\\"ts\\":\\"$now\\",\\"event\\":\\"ledger_shadow_error\\"}" >> "$AGENT_CHAT_HOME/broker.log\${FAKE_LOG_SUFFIX:-}"
    done ;;
  "agent ls")
    [ -z "\${FAKE_LS_FAIL:-}" ] || exit 1
    echo "\${FAKE_LS_OUT:-[]}" ;;
esac`),
}

let dir: string
let repo: string
let home: string
let log: string

const liveMarkers = (): string[] =>
  ['node_modules', 'dist'].map(d => fs.readFileSync(path.join(repo, d, 'marker'), 'utf8').trim())

const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

const pushToOrigin = (file: string): string => {
  const other = path.join(dir, 'other')
  const inOther = (...args: string[]): string =>
    execFileSync('git', ['-C', other, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    })
  execFileSync('git', ['clone', '-q', path.join(dir, 'origin.git'), other])
  fs.writeFileSync(path.join(other, file), 'r')
  inOther('add', '.')
  inOther('commit', '-q', '-m', file)
  inOther('push', '-q', 'origin', 'main')
  return inOther('rev-parse', 'HEAD').trim()
}

const distAtRestarts = (): string => fs.readFileSync(path.join(dir, 'dist.log'), 'utf8')

const liveGaps = (): string => {
  const gaps = path.join(dir, 'gap.log')
  return fs.existsSync(gaps) ? fs.readFileSync(gaps, 'utf8') : ''
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-window-')))
  const origin = path.join(dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
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
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\ndist\n')
  for (const live of ['node_modules', 'dist']) {
    fs.mkdirSync(path.join(repo, live))
    fs.writeFileSync(path.join(repo, live, 'marker'), 'old')
  }
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  home = path.join(dir, 'home')
  fs.mkdirSync(home)
  log = path.join(dir, 'shim.log')
  fs.writeFileSync(log, '')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const shimEnv = (env: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
  HOME: dir,
  AGENT_CHAT_HOME: home,
  SHIM_LOG: log,
  SHIM_CWD_LOG: path.join(dir, 'cwd.log'),
  SHIM_DIST_LOG: path.join(dir, 'dist.log'),
  SHIM_REPO: repo,
  SHIM_GAP_LOG: path.join(dir, 'gap.log'),
  ...env,
})

const run = (env: Record<string, string> = {}, args: string[] = []) => {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: shimEnv(env) })
  return { code: result.status, out: result.stdout, err: result.stderr, calls: fs.readFileSync(log, 'utf8') }
}

const patternFromScript = (name: string): RegExp => {
  const match = new RegExp(`^${name}='(.*)'$`, 'm').exec(fs.readFileSync(SCRIPT, 'utf8'))
  return new RegExp(match![1]!.replace(/\(agent-chat\|index\\\.js\)/g, '(agent-chat|index\\.js)'))
}

describe('restart-window process patterns', () => {
  const push = patternFromScript('PUSH_RE')
  const merge = patternFromScript('MERGE_RE')

  it('matches the absolute-path git push the agent shim runs', () => {
    expect(push.test('/opt/homebrew/bin/git push --dry-run origin main')).toBe(true)
    expect(push.test('git push origin main')).toBe(true)
    expect(push.test('/opt/homebrew/bin/git -C /x/work/tree push origin HEAD')).toBe(true)
    expect(push.test('/usr/lib/git-core/git-remote-https origin https://example.invalid/r.git')).toBe(true)
  })

  it('matches a git push behind -c and long global options', () => {
    expect(push.test('git -c core.askPass=x push origin main')).toBe(true)
    expect(push.test('/usr/bin/git --no-pager push')).toBe(true)
    expect(push.test('git -C /x -c a=b --no-pager push origin HEAD')).toBe(true)
  })

  it('does not match other git commands that mention push', () => {
    expect(push.test('git log --grep push')).toBe(false)
    expect(push.test('/opt/homebrew/bin/git log --grep "git push"')).toBe(false)
  })

  it('matches the merge tools and not a plain gh pr view', () => {
    expect(merge.test('/bin/bash /x/bin/seat-merge seat o/r 1 abc')).toBe(true)
    expect(merge.test('/opt/homebrew/bin/gh pr merge 5 --squash')).toBe(true)
    expect(merge.test('node /x/dist/cli/index.js gh-write -- pr merge 5')).toBe(true)
    expect(merge.test('gh pr view 5')).toBe(false)
  })
})

describe('restart-window pre-checks', () => {
  it('exits 1 with the guard message when the restart refuses on an open ask', () => {
    const r = run({ FAKE_RESTART_FAIL: 'refusing to restart: unanswered ask from alice' })

    expect(r.code).toBe(1)
    expect(r.out).toContain('unanswered ask from alice')
    expect(r.out).not.toContain('BROKER MAY BE DOWN')
  })

  it('refuses and names the pids when a git push is running', () => {
    const r = run({ FAKE_PGREP_PUSH: '4242,4243' })

    expect(r.code).toBe(1)
    expect(r.err).toContain('4242,4243')
    expect(r.calls).toBe('')
  })

  it('refuses and names the pids when a merge is running', () => {
    const r = run({ FAKE_PGREP_MERGE: '777' })

    expect(r.code).toBe(1)
    expect(r.err).toContain('merge is running (pid 777)')
    expect(r.calls).toBe('')
  })

  it('refuses when the installed checkout is on another branch', () => {
    git('checkout', '-q', '-b', 'feature')
    const r = run()

    expect(r.code).toBe(1)
    expect(r.err).toContain("'feature', not main")
    expect(r.calls).toBe('')
  })

  it('refuses when the installed checkout is dirty', () => {
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'x')
    const r = run()

    expect(r.code).toBe(1)
    expect(r.err).toContain('uncommitted changes')
    expect(r.calls).toBe('')
  })

  it.each(['node_modules', 'dist'])('refuses on a leftover %s.prev and names both recoveries', name => {
    fs.mkdirSync(path.join(repo, `${name}.prev`))
    const r = run()

    expect(r.code).toBe(1)
    expect(r.err).toContain('a .prev build is left from an earlier run')
    expect(r.err).toContain(`mv ${name}.prev ${name}`)
    expect(r.err).toContain(`to keep the current build: rm -rf ${repo}/node_modules.prev ${repo}/dist.prev`)
    expect(r.calls).toBe('')
  })

  it('names one command that restores the old commit and build left by a failed post-check', () => {
    const head = git('rev-parse', 'HEAD')
    pushToOrigin('remote.txt')
    run({ FAKE_STARTED: '0' })
    const r = run()
    const rollback = /to roll back: (.*); to keep the current build/.exec(r.err)![1]!

    expect(r.code).toBe(1)
    execFileSync('bash', ['-c', rollback], { env: shimEnv() })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(liveMarkers()).toEqual(['old', 'old'])
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.gitignore', 'bin', 'dist', 'node_modules'])
  })

  it('rejects any argument, including --force', () => {
    const r = run({}, ['--force'])

    expect(r.code).toBe(1)
    expect(r.calls).toBe('')
  })
})

describe('restart-window update and restart', () => {
  it.each(['ci', 'run build'])('exits 4 before touching the broker when npm %s fails', step => {
    const r = run({ FAKE_NPM_FAIL: step })

    expect(r.code).toBe(4)
    expect(r.calls).not.toContain('service restart')
  })

  it('leaves the live node_modules and dist intact when the staged step fails', () => {
    for (const step of ['ci', 'run build']) {
      const r = run({ FAKE_NPM_FAIL: step })

      expect(r.code).toBe(4)
      expect(liveMarkers()).toEqual(['old', 'old'])
      expect(fs.existsSync(`${repo}.staging`)).toBe(false)
    }
  })

  it('exits 4 and leaves the live tree untouched when origin is not a fast-forward', () => {
    pushToOrigin('remote.txt')
    fs.writeFileSync(path.join(repo, 'local.txt'), 'l')
    git('add', '.')
    git('commit', '-q', '-m', 'local')
    const head = git('rev-parse', 'HEAD')
    const r = run()

    expect(r.code).toBe(4)
    expect(r.calls).toBe('')
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(liveMarkers()).toEqual(['old', 'old'])
  })

  it('builds the fetched commit and keeps live src on the old commit when the build fails', () => {
    const head = git('rev-parse', 'HEAD')
    pushToOrigin('remote.txt')
    const r = run({ FAKE_NPM_FAIL: 'run build' })

    expect(r.code).toBe(4)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(fs.existsSync(path.join(repo, 'remote.txt'))).toBe(false)
    expect(liveMarkers()).toEqual(['old', 'old'])
  })

  it('advances live src to the fetched commit on success', () => {
    const fetched = pushToOrigin('remote.txt')
    const r = run()

    expect(r.code).toBe(0)
    expect(git('rev-parse', 'HEAD').trim()).toBe(fetched)
    expect(fs.existsSync(path.join(repo, 'remote.txt'))).toBe(true)
  })

  it('runs npm in the staging dir and swaps the staged install and build in on success', () => {
    const r = run()

    expect(r.code).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'cwd.log'), 'utf8')).toBe(
      `cwd ${repo}.staging\ncwd ${repo}.staging\n`,
    )
    expect(liveMarkers()).toEqual(['new', 'new'])
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.gitignore', 'bin', 'dist', 'node_modules'])
    expect(fs.existsSync(`${repo}.staging`)).toBe(false)
  })

  it('exits 3 and says the broker may be down when the restart fails', () => {
    const r = run({ FAKE_RESTART_FAIL: 'Started, but nothing is answering' })

    expect(r.code).toBe(3)
    expect(r.out).toContain('BROKER MAY BE DOWN: run agent-chat service start')
  })

  it('on a failed restart restores the old build and commit and restarts the broker on it', () => {
    const head = git('rev-parse', 'HEAD')
    pushToOrigin('remote.txt')
    const r = run({ FAKE_RESTART_FAIL_ONCE: 'Started, but nothing is answering' })

    expect(r.code).toBe(3)
    expect(distAtRestarts()).toBe('new\nold\n')
    expect(liveMarkers()).toEqual(['old', 'old'])
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.gitignore', 'bin', 'dist', 'node_modules'])
    expect(r.out).toContain('rolled back; the broker runs the old build')
    expect(r.out).not.toContain('BROKER MAY BE DOWN')
    expect(liveGaps()).toBe('')
  })

  it('on a failed restart still restarts on the old build when the src reset fails', () => {
    pushToOrigin('remote.txt')
    const r = run({
      FAKE_RESTART_FAIL_ONCE: 'Started, but nothing is answering',
      FAKE_EDIT_TRACKED: 'remote.txt',
    })

    expect(r.code).toBe(3)
    expect(distAtRestarts()).toBe('new\nold\n')
    expect(liveMarkers()).toEqual(['old', 'old'])
    expect(r.err).toContain('the old build is back but src is not')
    expect(r.out).toContain('rolled back; the broker runs the old build')
  })

  it('rolls the swap and src back without a gap in the live build when the restart guard refuses', () => {
    const head = git('rev-parse', 'HEAD')
    pushToOrigin('remote.txt')
    const r = run({ FAKE_RESTART_FAIL: 'refusing to restart: unanswered ask from alice' })

    expect(r.code).toBe(1)
    expect(liveMarkers()).toEqual(['old', 'old'])
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(fs.readdirSync(repo).sort()).toEqual(['.git', '.gitignore', 'bin', 'dist', 'node_modules'])
    expect(liveGaps()).toBe('')
  })

  it('installs and builds before it restarts', () => {
    const r = run()

    expect(r.calls.split('\n').filter(Boolean)).toEqual([
      'npm ci',
      'npm run build',
      'agent-chat service restart',
      'agent-chat agent ls --json',
    ])
  })
})

describe('restart-window post-checks', () => {
  it('prints OK after a clean restart', () => {
    const r = run()

    expect(r.code).toBe(0)
    expect(r.out).toContain('restart-window OK')
  })

  it.each([
    ['no broker_started line', { FAKE_STARTED: '0' }, 'exactly one broker_started'],
    ['two broker_started lines', { FAKE_STARTED: '2' }, 'exactly one broker_started'],
    ['a ledger_shadow_error line', { FAKE_SHADOW_ERRORS: '1' }, 'no ledger_shadow_error'],
    ['agent ls exiting non-zero', { FAKE_LS_FAIL: '1' }, 'agent ls --json parses'],
    ['agent ls printing non-JSON', { FAKE_LS_OUT: 'not json' }, 'agent ls --json parses'],
  ])('exits 2 on %s', (_name, env, line) => {
    const r = run(env)

    expect(r.code).toBe(2)
    expect(r.out).toContain(`FAIL: ${line}`)
    expect(r.out).not.toContain('restart-window OK')
  })

  it('keeps the old build as .prev and names the rollback when a post-check fails', () => {
    const r = run({ FAKE_STARTED: '0' })

    expect(r.code).toBe(2)
    expect(liveMarkers()).toEqual(['new', 'new'])
    for (const name of ['node_modules', 'dist']) {
      expect(fs.readFileSync(path.join(repo, `${name}.prev`, 'marker'), 'utf8')).toBe('old')
    }
    expect(r.out).toContain(`to roll back: cd ${repo} && git reset --keep`)
  })

  it('ignores log lines from before the restart', () => {
    const old = '2020-01-01T00:00:00.000Z'
    fs.writeFileSync(
      path.join(home, 'broker.log'),
      `{"ts":"${old}","event":"broker_started"}\n{"ts":"${old}","event":"ledger_shadow_error"}\n`,
    )
    const r = run()

    expect(r.code).toBe(0)
  })

  it('counts a ledger_shadow_error that landed in the rotated broker.log.1', () => {
    const r = run({ FAKE_SHADOW_ERRORS: '1', FAKE_LOG_SUFFIX: '.1' })

    expect(r.code).toBe(2)
    expect(r.out).toContain('FAIL: no ledger_shadow_error')
  })
})
