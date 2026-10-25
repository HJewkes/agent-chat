import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import type { ReadAlias } from '../leak-guard/git-alias.js'

/**
 * The `no-rewrite` push policy (CC-1633) decides on the argv the shell builds, so every spelling of
 * the push word and every wrapper the guard unwraps reaches it. The policy is read from the hook's
 * own env; a line that exports, unsets or prefixes the variable does not reach that env.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'push-policy-'))
fs.writeFileSync(path.join(scratch, '--delete'), '')
fs.writeFileSync(path.join(scratch, 'z'), '')
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

const ON = { AGENT_CHAT_PUSH_POLICY: 'no-rewrite', PWD: scratch, dir: scratch }

// `git pp` where the repo's config holds alias.pp=push.
const pushAlias: ReadAlias = word => (word === 'pp' ? { value: 'push', runsIn: scratch } : undefined)

const ctx = (env: Record<string, string> = ON): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: scratch,
  env,
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: pushAlias,
  readIncludedHooksPath: () => false,
})

const DELETE = 'origin --delete x'

// Each spelling of the push word and each wrapper the guard unwraps, carrying a delete.
const SPELLINGS = [
  `git push ${DELETE}`,
  `git "push" ${DELETE}`,
  `git 'push' ${DELETE}`,
  `git pu\\sh ${DELETE}`,
  `git p"ush" ${DELETE}`,
  `git pu''sh ${DELETE}`,
  `git -C . push'' ${DELETE}`,
  `git -C . push>f ${DELETE}`,
  `git push>f ${DELETE}`,
  `git push</dev/null ${DELETE}`,
  `/usr/bin/git push ${DELETE}`,
  `command git push ${DELETE}`,
  `env git push ${DELETE}`,
  `bash -c "git push ${DELETE}"`,
  `sh -c 'git "push" ${DELETE}'`,
  `git pp ${DELETE}`,
]

// Each rewriting form the policy names, on a plain push.
const FORMS = [
  'git push origin z *',
  'git push --force origin x',
  'git push -f origin x',
  'git push -uf origin x',
  'git push --forc origin x',
  'git push --force-with-lease origin x',
  'git push --force-with-lease=x:abc origin x',
  'git push --force-if-includes origin x',
  'git push -d origin x',
  'git push --del origin x',
  'git push --mirror origin',
  'git push --prune origin refs/heads/*:refs/heads/*',
  'git push --all origin',
  'git push origin +x',
  'git push origin :x',
  'git push origin HEAD:main',
  'git push origin HEAD:master',
  'git push origin x:refs/heads/main',
  'git push origin x:heads/main',
  'git push origin main',
  'git push -u origin master',
  'git push -- origin :x',
  'git push -o ci.skip -- origin HEAD:main',
  'git push origin "$(git branch --show-current)"',
  'git push origin {a,:x}',
  'B=main; git push origin "$B"',
]

// The line tries to switch the policy off before the push; the hook's env is not the line's.
const TAMPERS = [
  `export AGENT_CHAT_PUSH_POLICY=; git push ${DELETE}`,
  `unset AGENT_CHAT_PUSH_POLICY; git push ${DELETE}`,
  `AGENT_CHAT_PUSH_POLICY= git push ${DELETE}`,
  `AGENT_CHAT_PUSH_POLICY=off git push ${DELETE}`,
  `env -u AGENT_CHAT_PUSH_POLICY git push ${DELETE}`,
  `env AGENT_CHAT_PUSH_POLICY=off git push ${DELETE}`,
]

const ALLOWED = [
  'git push -u origin HEAD:agent-chat/x',
  'git -C "$PWD" push -u origin HEAD:agent-chat/y',
  'git -C "$dir" commit -m "Deny quoted push"',
  'git stash push',
  'git pull --ff-only origin main',
  'git push origin feat/x',
  'git push -o ci.skip origin HEAD:agent-chat/x',
  'git push --tags origin',
  'git push --no-force-with-lease origin feat/x',
  'git log origin/main..HEAD',
]

describe('leak-guard push policy no-rewrite (CC-1633)', () => {
  it.each(SPELLINGS)('denies %j', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.pushRewrite)
  })

  it.each(FORMS)('denies %j', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.pushRewrite)
  })

  it.each(TAMPERS)('keeps the hook policy when the line changes the variable: %j', line => {
    expect(checkCommand(line, ctx())).toBe(REASONS.pushRewrite)
  })

  it.each(ALLOWED)('allows %j', line => {
    expect(checkCommand(line, ctx())).toBeUndefined()
  })

  it('denies an inline alias to push as before (CC-1622)', () => {
    expect(checkCommand(`git -c alias.pp=push pp ${DELETE}`, ctx())).toBe(REASONS.gitConfig)
    expect(checkCommand(`git -C . -c alias.pp=push pp ${DELETE}`, ctx())).toBe(REASONS.gitConfig)
  })

  it.each([`git push ${DELETE}`, 'git push --force origin x', 'git push origin HEAD:main'])(
    'leaves %j alone without the policy',
    line => {
      expect(checkCommand(line, ctx({ PWD: scratch }))).toBeUndefined()
    },
  )

  it('ignores a policy value it does not know', () => {
    expect(checkCommand(`git push ${DELETE}`, ctx({ AGENT_CHAT_PUSH_POLICY: 'off' }))).toBeUndefined()
  })
})
