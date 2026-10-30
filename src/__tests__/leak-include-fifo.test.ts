import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { includedHooksPathReader } from '../leak-guard/git-include.js'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { killQuietly, waitUntilGone } from './helpers/process-gone.js'
import { releaseFifos } from './helpers/run-root.js'

/**
 * A `-c include.path` naming a FIFO blocks git in open() until a writer arrives (TP-602). Split
 * from leak-pretool.test.ts because the wrapper case execs a script it wrote (CC-462, CC-1673).
 */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-include-fifo-'))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const emptyHome = path.join(SCRATCH, 'empty-home')
const READ_ENV: NodeJS.ProcessEnv = { ...process.env, HOME: emptyHome, XDG_CONFIG_HOME: emptyHome }
READ_ENV.GIT_CONFIG_NOSYSTEM = '1'
for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_WORK_TREE']) delete READ_ENV[name]

const plain = path.join(SCRATCH, 'plain')
execFileSync('git', ['init', '-q', plain], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })

const at = (env: NodeJS.ProcessEnv): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: plain,
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: includedHooksPathReader(env),
})

describe('an include git blocks on (CC-1673)', () => {
  const fifoDir = path.join(SCRATCH, 'include-fifo-dir')
  const fifo = path.join(fifoDir, 'include-fifo')
  const groupFile = path.join(fifoDir, 'git-group')

  /**
   * A git wrapper like the agent shim: the real git is a grandchild of the guard's spawn, so
   * killing only the direct child on timeout would leave it blocked on the FIFO.
   */
  const wrapperEnv = (): NodeJS.ProcessEnv => {
    const shimDir = path.join(fifoDir, 'shim')
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    fs.mkdirSync(shimDir)
    const wrapper = path.join(shimDir, 'git')
    const script = `#!/bin/sh\nPATH='${process.env.PATH}'\n'${realGit}' "$@" &\necho "$$ $!" > '${groupFile}'\nwait $!\n`
    fs.writeFileSync(wrapper, script, { mode: 0o755 })
    return { ...READ_ENV, PATH: `${shimDir}:${process.env.PATH}` }
  }

  const realGitPid = (): number => Number(fs.readFileSync(groupFile, 'utf8').split(' ')[1])

  beforeEach(() => {
    fs.mkdirSync(fifoDir)
    execFileSync('mkfifo', [fifo])
  })

  afterEach(() => {
    const [group] = fs.existsSync(groupFile) ? fs.readFileSync(groupFile, 'utf8').split(' ') : []
    if (group !== undefined) killQuietly(-Number(group))
    releaseFifos(fifoDir)
    fs.rmSync(fifoDir, { recursive: true, force: true })
  })

  it('denies an include git cannot read within the timeout', () => {
    expect(checkCommand(`git -c include.path=${fifo} push`, at(READ_ENV))).toBe(REASONS.includePath)
  })

  it('leaves no git behind a wrapper blocked on it after the timeout', async () => {
    expect(checkCommand(`git -c include.path=${fifo} push`, at(wrapperEnv()))).toBe(REASONS.includePath)
    expect(await waitUntilGone(realGitPid(), 2000)).toBe(true)
  })
})
