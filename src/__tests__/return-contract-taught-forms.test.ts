import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BODY_FILE_RULE,
  IMPLEMENTER_WITHOUT_SHEPHERD,
  QUOTE_RULE,
  RETURN_CONTRACT_BLOCKS,
} from '../agents/return-contract-blocks.js'
import { checkCommand, guardContext, type GuardContext } from '../leak-guard/pretool.js'

/**
 * CC-501 S3: text that teaches a form the leak guard refuses fails the build. Every command the
 * contract blocks show runs through `checkCommand` from a worktree like a real implementer's: a
 * git repo whose origin is a local bare repo, at a path with no symlink in it.
 */

// realpath: os.tmpdir() on macOS sits under /var, a symlink the guard refuses to defer through.
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-taught-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const WORKTREE = path.join(SCRATCH, 'projects', 'repo')
const BIN = path.join(SCRATCH, 'bin')
const CONFIG = path.join(SCRATCH, 'config')
const LINKED = path.join(SCRATCH, 'linked')

function setUp(): void {
  fs.mkdirSync(path.join(CONFIG, 'titan-egress'), { recursive: true })
  fs.writeFileSync(path.join(CONFIG, 'titan-egress', 'private-terms'), 'zq7privateseat\n', { mode: 0o600 })
  fs.mkdirSync(BIN)
  fs.symlinkSync(CLI, path.join(BIN, 'agent-chat'))
  execFileSync('git', ['init', '-q', '--bare', path.join(SCRATCH, 'origin.git')])
  execFileSync('git', ['init', '-q', WORKTREE])
  execFileSync('git', ['-C', WORKTREE, 'remote', 'add', 'origin', path.join(SCRATCH, 'origin.git')])
  fs.symlinkSync(WORKTREE, LINKED)
}
setUp()

const ENV = { PATH: `${BIN}:/usr/bin:/bin`, HOME: SCRATCH, XDG_CONFIG_HOME: CONFIG }

const at = (cwd: string): GuardContext => guardContext(ENV, cwd, SCRATCH, path.join(BIN, 'agent-chat'))

/** The built hook's stdout: empty when it allows, a JSON decision when it denies. */
const hook = (command: string, cwd: string): string =>
  execFileSync(process.execPath, [CLI, 'leak-guard', 'pretool'], {
    input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } }),
    env: ENV,
    encoding: 'utf8',
  })

const PLACEHOLDERS: Record<string, string> = {
  '<owner>/<repo>': 'example/repo',
  '<head>': 'a'.repeat(40),
  '<default>': 'main',
  '<ID>': 'CC-1',
  '<gh args>': 'pr create --title T',
  '<f>': 'pr-body.md',
  '<rev>': 'HEAD',
  '<path>': 'README.md',
}

const fill = (form: string): string =>
  Object.entries(PLACEHOLDERS).reduce((text, [from, to]) => text.replaceAll(from, to), form)

/** The commands a block shows: backticked spans that start with git, gh or agent-chat, and the CI paste. */
function shownCommands(block: string): string[] {
  const spans = [...block.matchAll(/`([^`]+)`/g)].map(m => m[1] ?? '')
  const paste = [...block.matchAll(/<paste of: (.+)>,/g)].map(m => m[1] ?? '')
  return [...spans.filter(span => /^(git|gh|agent-chat) /.test(span)), ...paste]
}

const BODY = 'A synthetic PR body.\n'
const POST = fill('agent-chat gh-write -- <gh args> --body-file <f>')
const ONE_CALL = `cat > pr-body.md <<'EOF'\n${BODY}EOF\n${POST}`

describe('every command form the return contract teaches is one the leak guard allows', () => {
  const blocks = [
    RETURN_CONTRACT_BLOCKS.implementer,
    IMPLEMENTER_WITHOUT_SHEPHERD,
    RETURN_CONTRACT_BLOCKS.reviewer,
  ]
  const forms = [...new Set(blocks.flatMap(shownCommands))]

  it('finds the forms it is meant to check', () => {
    expect(forms).toContain('agent-chat gh-write -- <gh args> --body-file <f>')
    expect(forms).toContain('git -C "$dir"')
    expect(
      forms.some(form => form.startsWith('gh api "repos/<owner>/<repo>/commits/<head>/check-runs"')),
    ).toBe(true)
  })

  it.each(forms)('allows %s', form => {
    const command = fill(form)
    expect(command).not.toMatch(/<[a-z ]+>/)
    expect(checkCommand(command, at(WORKTREE))).toBeUndefined()
  })

  it('allows a body written by a quoted heredoc and posted on the same line', () => {
    expect(checkCommand(ONE_CALL, at(WORKTREE))).toBeUndefined()
  })

  it('allows a body file already in the worktree, as the Write tool leaves it', () => {
    fs.writeFileSync(path.join(WORKTREE, 'pr-body.md'), BODY)
    expect(checkCommand(POST, at(WORKTREE))).toBeUndefined()
    fs.rmSync(path.join(WORKTREE, 'pr-body.md'))
  })

  // The docs/leak-guard.md caveat: a reviewer's cwd under $TMPDIR arrives through /var, a symlink.
  it('denies the one-call form from a working directory reached through a symlink', () => {
    expect(checkCommand(ONE_CALL, at(LINKED))).toBeDefined()
  })

  it('gets the same answers from the built hook', () => {
    expect(hook(ONE_CALL, WORKTREE)).toBe('')
    expect(JSON.parse(hook(ONE_CALL, LINKED)).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('the repo profile templates', () => {
  it.each(['bd-implementer', 'bd-implementer-lite', 'bd-reviewer'])('%s carries the two sentences', name => {
    const file = path.resolve(import.meta.dirname, '../../profiles', `${name}.json`)
    const prelude = (JSON.parse(fs.readFileSync(file, 'utf8')) as { promptPrelude: string }).promptPrelude
    expect(prelude).toContain(BODY_FILE_RULE)
    expect(prelude).toContain(QUOTE_RULE)
  })
})
