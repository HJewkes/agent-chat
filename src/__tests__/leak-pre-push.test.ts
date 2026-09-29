import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { leakPrePush, parseRefUpdates } from '../cli/verbs/leak-pre-push.js'
import { gitHooksEnv, hookScripts, writeGitHooks } from '../leak-guard/hooks-dir.js'
import {
  cachedVisibility,
  gitHubRepo,
  VISIBILITY_TTL_MS,
  type VisibilityReader,
} from '../leak-guard/visibility.js'

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-prepush-')))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

/** A PATH dir holding only the named tools, so a test controls what the hook can find. */
function binWith(tools: { node?: boolean; agentChat?: boolean; git?: boolean }): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'bin-'))
  if (tools.node) fs.symlinkSync(process.execPath, path.join(dir, 'node'))
  if (tools.git)
    fs.symlinkSync(
      execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
      path.join(dir, 'git'),
    )
  if (tools.agentChat)
    fs.writeFileSync(path.join(dir, 'agent-chat'), `#!/bin/sh\nexec node '${CLI}' "$@"\n`, { mode: 0o755 })
  return dir
}

const SYSTEM_PATH = '/usr/bin:/bin'
const GUARD_PATH = `${binWith({ node: true, agentChat: true })}:${process.env.PATH ?? SYSTEM_PATH}`

// Every fixture is synthetic: a made-up home, a made-up TLD and made-up names.
const HOME = '/Users/zq7-probe-home'
const EMAIL = 'owner.zq7@leakprobe.zq7'
const NAME = 'zq7privateseat'
const ENTRIES = [HOME, EMAIL, NAME]
const LIST_JSON = JSON.stringify({ 'owner-email': [EMAIL], 'private-name': [NAME] })
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const ZERO = '0'.repeat(40)

const expectNoEntry = (output: string): void => {
  for (const entry of ENTRIES) expect(output.toLowerCase()).not.toContain(entry.toLowerCase())
}

describe('parseRefUpdates', () => {
  it('keeps pushed refs and drops deletions and malformed lines', () => {
    const stdin = [
      `refs/heads/a ${SHA_A} refs/heads/a ${ZERO}`,
      `(delete) ${ZERO} refs/heads/gone ${SHA_B}`,
      'not a ref line',
      `refs/heads/b ${SHA_B} refs/heads/b ${SHA_A}`,
    ].join('\n')

    expect(parseRefUpdates(stdin)).toEqual([
      { localSha: SHA_A, remoteSha: ZERO },
      { localSha: SHA_B, remoteSha: SHA_A },
    ])
  })
})

describe('gitHubRepo', () => {
  it.each([
    ['git@github.com:acme/widget.git', 'acme/widget'],
    ['https://github.com/acme/widget', 'acme/widget'],
    ['https://github.com/acme/widget.git', 'acme/widget'],
    ['ssh://git@github.com/acme/wid.get.git', 'acme/wid.get'],
    ['https://token@github.com/acme/widget.git', 'acme/widget'],
  ])('reads %s as %s', (url, repo) => {
    expect(gitHubRepo(url)).toBe(repo)
  })

  it('does not treat another host or a local path as GitHub', () => {
    expect(gitHubRepo('https://gitlab.com/acme/widget.git')).toBeUndefined()
    expect(gitHubRepo('/tmp/remote.git')).toBeUndefined()
  })
})

describe('cachedVisibility', () => {
  const cacheFile = (): string =>
    path.join(fs.mkdtempSync(path.join(SCRATCH, 'vis-')), 'repo-visibility.json')

  it('looks a GitHub remote up once and answers from the cache within a day', async () => {
    const file = cacheFile()
    const asked: string[] = []
    let now = 1_000
    const read = cachedVisibility(
      file,
      async repo => (asked.push(repo), 'public'),
      () => now,
    )

    expect(await read('git@github.com:acme/widget.git')).toBe('public')
    now += VISIBILITY_TTL_MS - 1
    expect(await read('https://github.com/acme/widget')).toBe('public')

    expect(asked).toEqual(['acme/widget'])
  })

  it('asks again once the cached answer is a day old', async () => {
    const file = cacheFile()
    let now = 1_000
    const answers = ['private', 'public']
    const read = cachedVisibility(
      file,
      async () => answers.shift() ?? '',
      () => now,
    )

    expect(await read('git@github.com:acme/widget.git')).toBe('private')
    now += VISIBILITY_TTL_MS
    expect(await read('git@github.com:acme/widget.git')).toBe('public')
  })

  it('counts a failed or odd lookup as unknown and does not cache it', async () => {
    const file = cacheFile()
    const answers: (() => Promise<string>)[] = [
      () => Promise.reject(new Error('rate limited')),
      async () => 'null',
      async () => 'internal',
    ]
    const read = cachedVisibility(file, () => answers.shift()!())

    expect(await read('git@github.com:acme/widget.git')).toBe('unknown')
    expect(await read('git@github.com:acme/widget.git')).toBe('unknown')
    expect(await read('git@github.com:acme/widget.git')).toBe('private')
  })

  it('never looks up a non-GitHub remote', async () => {
    const read = cachedVisibility(cacheFile(), () => {
      throw new Error('must not be called')
    })

    expect(await read('/tmp/remote.git')).toBe('unknown')
  })
})

describe('hookScripts', () => {
  // Regression: a baked Cellar node or worktree dist path refused every push once it went away.
  it('bakes in no node or cli path, finding both on PATH when the hook runs', () => {
    const shim = hookScripts().get('pre-push') ?? ''

    expect(shim).not.toContain(process.execPath)
    expect(shim).not.toContain('cli.js')
    expect(shim).toContain('agent-chat leak-scan --pre-push')
  })

  it('writes executable shims for pre-push and the gating commit hooks only', () => {
    const dir = path.join(SCRATCH, 'hooks-perm')
    writeGitHooks(dir)

    for (const name of ['pre-push', 'pre-commit', 'commit-msg'])
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o755)
    for (const hot of ['reference-transaction', 'post-index-change', 'post-commit', 'pre-receive', 'update'])
      expect(fs.existsSync(path.join(dir, hot))).toBe(false)
  })
})

interface Fixture {
  work: string
  remote: string
  chatHome: string
  marker: string
  agentEnv: NodeJS.ProcessEnv
}

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

function commitFile(f: Fixture, branch: string, file: string, text: string): void {
  git(f.work, baseEnv(), 'checkout', '-q', '-B', branch, 'main')
  fs.writeFileSync(path.join(f.work, file), `${text}\n`)
  git(f.work, baseEnv(), 'add', file)
  git(f.work, baseEnv(), 'commit', '-q', '-m', `add ${file}`)
}

type Visibility = 'public' | 'private' | undefined

/** A work repo whose origin is a local bare repo, with the guard hooks and a repo-local pre-push hook. */
function fixture(opts: { denylist?: string; visibility: Visibility }): Fixture {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
  const [work, remote, chatHome] = ['work', 'remote.git', 'chat'].map(d => path.join(root, d)) as [
    string,
    string,
    string,
  ]
  const marker = path.join(root, 'repo-hook-ran')
  fs.mkdirSync(chatHome)
  if (opts.denylist !== undefined)
    fs.writeFileSync(path.join(chatHome, 'private-denylist.json'), opts.denylist, { mode: 0o600 })
  if (opts.visibility !== undefined)
    fs.writeFileSync(
      path.join(chatHome, 'repo-visibility.json'),
      JSON.stringify({ [remote]: { visibility: opts.visibility, checkedAt: Date.now() } }),
    )
  git(root, baseEnv(), 'init', '-q', '--bare', remote)
  git(root, baseEnv(), 'init', '-q', '-b', 'main', work)
  git(work, baseEnv(), 'remote', 'add', 'origin', remote)
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n')
  git(work, baseEnv(), 'add', 'README.md')
  git(work, baseEnv(), 'commit', '-q', '-m', 'init')
  git(work, baseEnv(), 'push', '-q', 'origin', 'main')
  const repoHook = path.join(work, '.git', 'hooks', 'pre-push')
  fs.writeFileSync(repoHook, `#!/bin/sh\nread -r ref sha rest && echo "$1 $ref" >> '${marker}'\n`, {
    mode: 0o755,
  })
  const hooksDir = path.join(chatHome, 'git-hooks')
  writeGitHooks(hooksDir)
  const agentEnv = { ...baseEnv(), ...gitHooksEnv(hooksDir), AGENT_CHAT_HOME: chatHome, PATH: GUARD_PATH }
  return { work, remote, chatHome, marker, agentEnv }
}

function push(f: Fixture, branch: string): { code: number; stderr: string } {
  const run = spawnSync('git', ['push', '-q', 'origin', branch], {
    cwd: f.work,
    env: f.agentEnv,
    encoding: 'utf8',
  })
  return { code: run.status ?? -1, stderr: run.stderr }
}

const remoteHas = (f: Fixture, branch: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: f.remote, env: baseEnv() })
    .status === 0

const repoHookRuns = (f: Fixture): string[] =>
  fs.existsSync(f.marker) ? fs.readFileSync(f.marker, 'utf8').trim().split('\n') : []

describe('git push under the agent env', () => {
  it('points core.hooksPath at the guard dir', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })

    expect(git(f.work, f.agentEnv, 'config', 'core.hooksPath')).toBe(path.join(f.chatHome, 'git-hooks'))
    expect(git(f.work, baseEnv(), 'config', '--default', 'none', 'core.hooksPath')).toBe('none')
  })

  it('refuses a leak to a public remote with file:line, and still runs the repo hook', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
    commitFile(f, 'leaky', 'notes.md', `ping ${EMAIL}`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toMatch(/[0-9a-f]{12} notes\.md:1 {2}owner-email/)
    expect(run.stderr).toContain('push refused: the remote is public')
    expectNoEntry(run.stderr)
    expect(remoteHas(f, 'leaky')).toBe(false)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/leaky'])
  })

  it('lets a clean push through and runs the repo hook', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
    commitFile(f, 'clean', 'notes.md', 'nothing private at /Users/example/x')

    const run = push(f, 'clean')

    expect(run).toEqual({ code: 0, stderr: '' })
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/clean'])
  })

  it('refuses the push when the repo hook fails even though the scan is clean', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
    fs.writeFileSync(path.join(f.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    commitFile(f, 'clean', 'notes.md', 'fine')

    expect(push(f, 'clean').code).not.toBe(0)
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('refuses a leak when the remote visibility is unknown', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: undefined })
    commitFile(f, 'leaky', 'notes.md', `the ${NAME} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('push refused: the remote is of unknown visibility')
  })

  it('only warns about a leak to a private remote', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'private' })
    commitFile(f, 'leaky', 'notes.md', `ping ${EMAIL}`)

    const run = push(f, 'leaky')

    expect(run.code).toBe(0)
    expect(run.stderr).toContain('notes.md:1  owner-email')
    expect(run.stderr).toContain('the remote is private, so this is a warning')
    expect(remoteHas(f, 'leaky')).toBe(true)
  })

  it('chains other hooks, so a repo pre-commit hook still refuses a commit', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
    fs.writeFileSync(path.join(f.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(f.work, 'x.md'), 'x\n')
    git(f.work, f.agentEnv, 'add', 'x.md')

    const run = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: f.work, env: f.agentEnv })

    expect(run.status).not.toBe(0)
  })

  it('does not loop when the repo itself points core.hooksPath at the guard dir', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
    git(f.work, baseEnv(), 'config', 'core.hooksPath', path.join(f.chatHome, 'git-hooks'))
    commitFile(f, 'clean', 'notes.md', 'fine')

    expect(push(f, 'clean')).toEqual({ code: 0, stderr: '' })
  })

  it('scans only commits the remote lacks, so an already-pushed leak does not block the next push', () => {
    const f = fixture({ denylist: LIST_JSON, visibility: 'private' })
    commitFile(f, 'topic', 'notes.md', `ping ${EMAIL}`)
    expect(push(f, 'topic').code).toBe(0)
    fs.writeFileSync(path.join(f.chatHome, 'repo-visibility.json'), JSON.stringify({}))
    fs.appendFileSync(path.join(f.work, 'notes.md'), 'more\n')
    git(f.work, baseEnv(), 'commit', '-q', '-am', 'more')

    expect(push(f, 'topic')).toEqual({ code: 0, stderr: '' })
  })
})

describe('git push with no deny-list yet', () => {
  it('lets a push through that only the deny-list would flag, with one line naming the missing file', () => {
    const f = fixture({ visibility: 'public' })
    commitFile(f, 'mail', 'notes.md', `ping ${EMAIL}`)

    const run = push(f, 'mail')

    expect(run.code).toBe(0)
    const file = path.join(f.chatHome, 'private-denylist.json')
    expect(run.stderr.trim().split('\n')).toEqual([
      `leak-scan: no deny-list at ${file}, so only home-path was checked. See docs/leak-guard.md.`,
    ])
    expect(remoteHas(f, 'mail')).toBe(true)
  })

  it('treats an empty deny-list the same way', () => {
    const f = fixture({ denylist: '{}', visibility: 'public' })
    commitFile(f, 'mail', 'notes.md', `ping ${EMAIL}`)

    const run = push(f, 'mail')

    expect(run.code).toBe(0)
    expect(run.stderr).toContain('leak-scan: no deny-list entries at')
  })

  it('still refuses a home-path leak to a public remote', () => {
    const f = fixture({ visibility: 'public' })
    commitFile(f, 'home', 'notes.md', `see ${HOME}/scratch`)

    const run = push(f, 'home')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toMatch(/notes\.md:1 {2}home-path/)
    expect(run.stderr).toContain('See docs/leak-guard.md.')
    expectNoEntry(run.stderr)
    expect(remoteHas(f, 'home')).toBe(false)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/home'])
  })

  it('refuses every push to a public remote when the deny-list exists but is unreadable', () => {
    const f = fixture({ denylist: `{"owner-email": "${EMAIL}"`, visibility: 'public' })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('is not valid JSON, so the push is refused unless the remote is private')
    expect(run.stderr).toContain('Fix its permissions or delete it')
    expectNoEntry(run.stderr)
  })
})

describe('git push when the guard cannot run', () => {
  const pathWithout = (tool: 'node' | 'agent-chat'): string =>
    [binWith({ git: true, node: tool !== 'node', agentChat: tool !== 'agent-chat' }), SYSTEM_PATH].join(':')

  // Fail open: a guard that cannot start must not refuse every push; S3's tick backstop still reports leaks.
  it.each(['agent-chat', 'node'] as const)(
    'lets the push through with one loud line when %s is not on PATH, and still runs the repo hook',
    tool => {
      const onSystemPath = SYSTEM_PATH.split(':').some(dir => fs.existsSync(path.join(dir, tool)))
      if (onSystemPath) return
      const f = fixture({ denylist: LIST_JSON, visibility: 'public' })
      f.agentEnv.PATH = pathWithout(tool)
      commitFile(f, 'leaky', 'notes.md', `ping ${EMAIL}`)

      const run = push(f, 'leaky')

      expect(run.code).toBe(0)
      expect(run.stderr.trim().split('\n')).toEqual([
        expect.stringMatching(
          new RegExp(`^leak-scan: guard NOT run, this push was not scanned: no ${tool} on PATH\\.`),
        ),
      ])
      expect(repoHookRuns(f)).toEqual(['origin refs/heads/leaky'])
    },
  )
})

describe('leakPrePush visibility failures', () => {
  const saved = process.env.AGENT_CHAT_HOME
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_CHAT_HOME
    else process.env.AGENT_CHAT_HOME = saved
  })

  const throwing: Record<string, VisibilityReader> = {
    rejects: () => Promise.reject(new Error('gh exploded')),
    throws: () => {
      throw new Error('gh exploded')
    },
  }

  // Mutation M9: a reader that throws was treated as private.
  it.each(Object.keys(throwing))('counts a reader that %s as unknown and refuses the leak', async kind => {
    const f = fixture({ denylist: LIST_JSON, visibility: undefined })
    commitFile(f, 'leaky', 'notes.md', `ping ${EMAIL}`)
    process.env.AGENT_CHAT_HOME = f.chatHome
    const sha = git(f.work, baseEnv(), 'rev-parse', 'leaky')
    const err: string[] = []
    const io = { out: () => undefined, err: (l: string) => err.push(l), home: HOME, cwd: f.work }

    const code = await leakPrePush(
      { remote: 'origin', url: f.remote },
      `refs/heads/leaky ${sha} refs/heads/leaky ${ZERO}\n`,
      { io, visibility: throwing[kind]! },
    )

    expect(code).toBe(1)
    expect(err.at(-1)).toBe('leak-scan: push refused: the remote is of unknown visibility.')
  })
})
