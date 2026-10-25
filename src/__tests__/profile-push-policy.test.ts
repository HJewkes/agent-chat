import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import { BUILTIN_PROFILES, loadProfile } from '../agents/profiles.js'
import type { AgentProfile } from '../agents/types.js'
import { hooksDirOf, termsFileFor, writeGitHooks } from '../leak-guard/hooks-dir.js'

/**
 * CC-1649: every shipped profile, the repo's profiles/*.json and the builtins, launches with the
 * no-rewrite pre-push hook, so a by-name push to main is refused whoever the agent is. Each row
 * goes through the launch path itself: buildLaunchPlan picks the hooks dir, the launch writes it,
 * and real git pushes to a local bare origin with the plan's GIT_CONFIG_* environment.
 */

const PROFILES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../profiles')
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-profile-push-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

const repoProfile = (file: string): AgentProfile => {
  const loaded = loadProfile(path.basename(file, '.json'), PROFILES_DIR)
  if ('error' in loaded) throw new Error(loaded.error)
  return loaded
}

const SHIPPED: AgentProfile[] = [
  ...fs
    .readdirSync(PROFILES_DIR)
    .filter(file => file.endsWith('.json'))
    .map(repoProfile),
  ...BUILTIN_PROFILES,
]

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: '/Users/example',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()

function commit(work: string, file: string): void {
  fs.writeFileSync(path.join(work, file), `${file}\n`)
  git(work, 'add', file)
  git(work, 'commit', '-q', '-m', `add ${file}`)
}

// A scanner that finds nothing, so only the push policy can refuse.
function scanPath(root: string): string {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.symlinkSync(REAL_GIT, path.join(bin, 'git'))
  const scanner = `#!/bin/sh\n[ "$1" = --help ] && { echo 'pre-push <remote>; files are scanned as text'; exit 0; }\ncat >/dev/null\nexit 0\n`
  fs.writeFileSync(path.join(bin, 'titan-egress-scan'), scanner, { mode: 0o755 })
  return `${bin}:/usr/bin:/bin`
}

/** The env git runs with under this profile's launch plan, after the launch wrote its hooks dir. */
function launchedGitEnv(profile: AgentProfile, root: string): NodeJS.ProcessEnv {
  const owner = path.join(root, 'owner')
  fs.mkdirSync(path.dirname(termsFileFor(owner)), { recursive: true })
  fs.writeFileSync(termsFileFor(owner), 'zq7leakterm\n', { mode: 0o600 })
  const plan = buildLaunchPlan({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'probe',
    profile,
    brief: 'probe',
    cwd: root,
    cwdHoldsUserSettings: false,
    adopted: false,
    mcpConfigPath: path.join(root, 'mcp.json'),
    gitHooksDir: path.join(root, 'chat', 'git-hooks'),
  })
  const hooks = hooksDirOf(plan.env)
  if (hooks === undefined) throw new Error('the launch plan carries no hooks dir')
  writeGitHooks(hooks, { missingTermsRefuses: true, home: owner, path: scanPath(root) })
  const gitKeys = Object.entries(plan.env).filter(([key]) => key.startsWith('GIT_CONFIG_'))
  return { ...baseEnv(), ...Object.fromEntries(gitKeys) }
}

/** A work repo one commit ahead of a bare origin's main, pushing `main` by name. */
function pushMainByName(profile: AgentProfile): { code: number; stderr: string; landed: boolean } {
  const root = fs.mkdtempSync(path.join(SCRATCH, `${profile.name}-`))
  const [work, remote] = [path.join(root, 'work'), path.join(root, 'remote.git')]
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'remote', 'add', 'origin', remote)
  commit(work, 'README.md')
  git(work, 'push', '-q', 'origin', 'main')
  const before = git(remote, 'rev-parse', 'main')
  commit(work, 'ahead.md')
  const env = launchedGitEnv(profile, root)
  const out = spawnSync('git', ['push', 'origin', 'main'], { cwd: work, env, encoding: 'utf8' })
  return { code: out.status ?? -1, stderr: out.stderr, landed: git(remote, 'rev-parse', 'main') !== before }
}

describe('every shipped profile launches with the no-rewrite push policy (CC-1649)', () => {
  it('finds the repo profiles and the builtins', () => {
    expect(SHIPPED.map(p => p.name)).toEqual(
      expect.arrayContaining(['bd-implementer', 'bd-planner', 'implementer']),
    )
  })

  // Mutation caught: dropping pushPolicy from any profile file or builtin.
  it.each(SHIPPED.map(p => [p.name, p] as const))('%s sets pushPolicy no-rewrite', (_name, profile) => {
    expect(profile.pushPolicy).toBe('no-rewrite')
  })

  // Mutation caught: the same, or guardEnv ignoring pushPolicy, seen as a push that lands.
  it.each(SHIPPED.map(p => [p.name, p] as const))(
    '%s: a by-name push to main is refused',
    (_name, profile) => {
      const outcome = pushMainByName(profile)

      expect(outcome.landed).toBe(false)
      expect(outcome.code).not.toBe(0)
      expect(outcome.stderr).toMatch(
        /push refused by the no-rewrite push policy \(CC-1633\): it updates refs\/heads\/main;/,
      )
    },
  )
})
