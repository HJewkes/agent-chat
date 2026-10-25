import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'
import { fakeGitShells } from './helpers/fake-git-shells.js'

/**
 * Text piped or fed into a shell is a script (CC-1393). Real shells with a fake `git` first on
 * PATH confirm each bypass row runs the push, and that each benign row runs no git or only what
 * the guard read.
 */

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

const PUSH = 'git push --no-verify'

// Each row: the line, the reason the guard gives, and the mutation in src/leak-guard that the row catches.
const BYPASSES: [string, string][] = [
  // Drop the fed-text check in checkShell: every row read through the pipe allows.
  [`echo "${PUSH}" | bash`, REASONS.noVerify],
  [`echo "${PUSH}" | sh`, REASONS.noVerify],
  [`echo "${PUSH}" | sh -s`, REASONS.noVerify],
  [`echo "${PUSH}" | zsh -f`, REASONS.noVerify],
  [`printf '${PUSH}\\n' | bash`, REASONS.noVerify],
  [`echo "${PUSH}" |& bash`, REASONS.noVerify],
  [`echo "${PUSH}" | sudo -n bash`, REASONS.noVerify],
  // Make passesThrough false for cat: cat hands on unknown text, and these deny as pipedScript.
  [`echo "${PUSH}" | cat | sh`, REASONS.noVerify],
  [`cat <<'EOF' | bash\n${PUSH}\nEOF`, REASONS.noVerify],
  [`echo "${PUSH}" | tee /dev/null | bash`, REASONS.noVerify],
  [`echo "${PUSH}" | bash -c 'cat | bash'`, REASONS.noVerify],
  // Stop feeds joining the pipe into the line's stdin: a shell in a group or a -c string reads nothing.
  [`printf '%s\\n' "${PUSH}" | bash -c bash`, REASONS.pipedScript],
  [`echo "${PUSH}" | { true; bash; }`, REASONS.noVerify],
  [`echo "${PUSH}" | (true; bash)`, REASONS.pipedScript],
  // Drop `prev.nested` in pipeFeed: the guard reads only `echo hi` from the subshell.
  [`(echo "${PUSH}"; echo hi) | bash`, REASONS.pipedScript],
  // Drop echo's backslash refusal: zsh's echo decodes \x79, so zsh's pipe carries --no-verify.
  [`echo 'git push --no-verif\\x79' | bash`, REASONS.pipedScript],
  [`printf '%s\\n' "${PUSH}" | bash`, REASONS.pipedScript],
  // Here-strings and heredocs, denied before CC-1393 too.
  [`bash <<< '${PUSH}'`, REASONS.noVerify],
  [`zsh -f <<< '${PUSH}'`, REASONS.noVerify],
  // ownFeed ignores stdinLive: the shell expands the body or reads the file, and the guard reads the raw text.
  [`F=--no-verify; cat <<EOF | bash\ngit push $F\nEOF`, REASONS.pipedScript],
  [`cat <<EOF | bash\ngit push --no-verif\\$'y'\nEOF`, REASONS.pipedScript],
  [`F=--no-verify; bash <<EOF\ngit push $F\nEOF`, REASONS.pipedScript],
  [`cat < push.sh | bash`, REASONS.pipedScript],
  // Gate the unknown-feed deny on namesGit again: no word of this line names git.
  [`G=gi; cat <<EOF | bash\n\${G}t push --no-verify\nEOF`, REASONS.pipedScript],
  // Drop the check of the heredoc as written: this denies as pipedScript instead.
  [`bash <<EOF\n${PUSH} $X\nEOF`, REASONS.noVerify],
]

// Each row's mutation: make an unknown pipe deny for every script source, or deny any pipe into a non-shell.
const BENIGN: [string, RegExp][] = [
  [`echo "${PUSH}" | grep -c push`, /^$/],
  [`echo "${PUSH}" | wc -l`, /^$/],
  [`printf '${PUSH}\\n' | tr a-z A-Z`, /^$/],
  [`echo 'git status' | bash`, /^status$/],
  [`git diff --name-only | bash -c 'while read f; do echo "$f"; done'`, /^diff --name-only$/],
  [`git log --oneline | head -3`, /^log --oneline$/],
  // Deny an unknown feed whatever the line: an expanded heredoc on a line that cannot reach git.
  [`cat <<EOF | wc -l\n$HOME\nEOF`, /^$/],
  [`bash <<EOF\necho $HOME\nEOF`, /^$/],
]

describe('checkCommand on text a shell reads as a script', () => {
  it.each(BYPASSES)('denies %j', (src, reason) => {
    expect(checkCommand(src, ctx())).toBe(reason)
  })

  it.each(BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

/** `depth` heredocs, each piped into a shell that `fanOut` runs `k` times around the next. */
function nestedFeeds(depth: number, k: number, fanOut: (shells: string) => string, tail: string): string {
  let inner = 'true'
  for (let level = 1; level <= depth; level++) {
    inner = `cat <<E${level} | ${fanOut(Array(k).fill('bash').join('; '))}\n${inner}\nE${level}`
  }
  return `${inner}${tail}`
}

const timed = (src: string): { reason: string | undefined; ms: number } => {
  const start = performance.now()
  const reason = checkCommand(src, ctx())
  return { reason, ms: performance.now() - start }
}

// Each later shell on the line re-reads every fed text, k^depth checks in all: 42 s for the first
// row without the line's fed-check budget, past the hook's 12 s deadline where it allows. Mutation:
// drop the budget in checkFed, and these rows time out.
describe('checkCommand on fed text that fans out', () => {
  const ROWS: [string, (shells: string) => string][] = [
    ['`;`-separated shells', shells => shells],
    ['a `{ …; }` group', shells => `{ ${shells}; }`],
  ]

  it.each(ROWS)(
    'denies a push after nested heredocs into %s',
    (_, fanOut) => {
      const { reason, ms } = timed(nestedFeeds(6, 12, fanOut, `\n${PUSH}`))

      expect(reason).toBe(REASONS.pipedScript)
      expect(ms).toBeLessThan(2_000)
    },
    5_000,
  )

  it('allows the same fan-out on a line that cannot reach git', () => {
    const { reason, ms } = timed(nestedFeeds(6, 12, shells => shells, '\ntrue'))

    expect(reason).toBeUndefined()
    expect(ms).toBeLessThan(2_000)
  }, 5_000)
})

const real = fakeGitShells('agent-chat-pretool-piped-', PUSH)
const { shells: SHELLS, hasZsh: HAS_ZSH, gitCalls } = real
// sudo must not prompt or escalate here: the fake runs its command as the test user.
fs.writeFileSync(path.join(real.bin, 'sudo'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })

afterAll(real.cleanup)

const needsZsh = (src: string): boolean => src.includes('zsh') || src.includes('\\x79')

describe.skipIf(SHELLS.length === 0)('real shells run what the guard reads from a pipe', () => {
  it('finds the fake git first on PATH', () => {
    expect(gitCalls('/bin/sh', [], 'git found')).toBe('found')
  })

  it.each(BYPASSES.filter(([src]) => HAS_ZSH || !needsZsh(src)))('a shell pushes for %j', src => {
    const pushed = SHELLS.filter(([shell, args]) => gitCalls(shell, args, src) === 'push --no-verify')

    expect(pushed.length).toBeGreaterThan(0)
  })

  it.each(BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of SHELLS) expect(gitCalls(shell, args, src)).toMatch(calls)
  })
})

// A process substitution reads what the command before it writes (CC-1416). Mutation: inherit the
// line's stdin in a process substitution again, and every row allows.
const PROCESS_SUBSTITUTIONS = [
  `echo '${PUSH}' > >(bash)`,
  `printf '${PUSH}\\n' > >(zsh)`,
  `echo '${PUSH}' > >(sh)`,
  `echo '${PUSH}' > >(dash)`,
  `echo '${PUSH}' > >(ksh)`,
  `echo '${PUSH}' 1> >(bash -s)`,
  `echo '${PUSH}' > >(bash -c bash)`,
  `echo '${PUSH}' | tee >(bash) > /dev/null`,
  `tee >(bash) <<< '${PUSH}' > /dev/null`,
  `x=$(echo '${PUSH}' > >(bash)); echo "$x"`,
]

// Denied though no shell runs the text: bash's operand is a path echo prints and never writes to.
const UNWRITTEN = [`echo '${PUSH}' >(bash)`, `echo '${PUSH}' >(sh)`]

// Mutation: make every process substitution deny, every subshell read 'unknown', or every command
// on a line with a process substitution read 'unknown'.
const PROCESS_BENIGN: [string, RegExp][] = [
  [`diff <(git show HEAD:a) <(git show HEAD:b)`, /^show HEAD:a\nshow HEAD:b$|^show HEAD:b\nshow HEAD:a$/],
  [`git log --oneline > >(wc -l)`, /^log --oneline$/],
  [`git status > >(cat); bash`, /^status$/],
  [`echo '${PUSH}' > >(cat > /dev/null)`, /^$/],
  [`f() ( bash ); git status`, /^status$/],
]

describe('checkCommand on a shell in a process substitution', () => {
  it.each([...PROCESS_SUBSTITUTIONS, ...UNWRITTEN])('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.pipedScript)
  })

  it.each(PROCESS_BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The git calls `src` made, waiting up to 3 s for a process substitution the shell did not wait for. */
function settledCalls(shell: string, args: string[], src: string): string {
  const record = path.join(real.root, 'git-calls')
  let calls = gitCalls(shell, args, src)
  for (let waited = 0; calls === '' && waited < 3_000; waited += 50) {
    pause(50)
    calls = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() : ''
  }
  return calls
}

const innerShell = (src: string): string => /\(\s*(\w+)/.exec(src.slice(src.indexOf('>(') + 1))?.[1] ?? 'bash'
const runnableHere = (src: string): boolean => fs.existsSync(`/bin/${innerShell(src)}`)

describe.skipIf(SHELLS.length === 0)('real shells run the push a process substitution reads', () => {
  it.each(PROCESS_SUBSTITUTIONS.filter(runnableHere))('every shell pushes for %j', src => {
    const pushed = SHELLS.filter(([shell, args]) => settledCalls(shell, args, src) === 'push --no-verify')

    expect(pushed.map(([shell]) => shell)).toEqual(SHELLS.map(([shell]) => shell))
  })

  it.each(UNWRITTEN)('no shell pushes for %j', src => {
    for (const [shell, args] of SHELLS) expect(gitCalls(shell, args, src)).toBe('')
  })

  it.each(PROCESS_BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of SHELLS) expect(gitCalls(shell, args, src)).toMatch(calls)
  })
})

// A shell in a command substitution reads the stdin of the command it sits in (CC-1412). Mutation:
// drop the pipe from ownsStdin, and every row denies no more.
const PIPED_SUBSTITUTIONS = [
  `echo '${PUSH}' | $(bash)`,
  `echo '${PUSH}' | \`bash\``,
  `echo '${PUSH}' | $( (bash) )`,
  `echo '${PUSH}' | $( $(bash) )`,
  `echo '${PUSH}' | $(sh)`,
  `echo '${PUSH}' | $(dash)`,
  `echo '${PUSH}' | $(zsh -f)`,
  `echo '${PUSH}' | $(bash -c bash)`,
  `echo '${PUSH}' | echo $(bash)`,
  `echo '${PUSH}' | x=$(bash)`,
  `printf '${PUSH}\\n' | cat | $(bash)`,
]

// Fail closed on a heredoc or redirect too, though shells open it only after the substitution ran.
// Mutation: drop the heredoc or the unread redirect from ownsStdin. A redirect on an expanded
// command word (`$(bash) < push.sh`) denies without this, so the redirect row names `echo`.
const REDIRECTED_SUBSTITUTIONS = [
  `$(bash) <<< '${PUSH}'`,
  `$(bash) <<'EOF'\n${PUSH}\nEOF`,
  `echo $(bash) < push.sh`,
]

// Mutation: make every command in a substitution read 'unknown'.
const SUBSTITUTION_BENIGN: [string, RegExp][] = [
  [`x=$( (bash) ); git status`, /^status$/],
  [`x=$(bash -c 'git rev-parse HEAD'); git status`, /^rev-parse HEAD\nstatus$/],
  [`git log --oneline | head -$(echo 3)`, /^log --oneline$/],
  [`echo '${PUSH}' | grep -c $(echo push)`, /^$/],
]

describe('checkCommand on a shell in a command substitution', () => {
  it.each(PIPED_SUBSTITUTIONS)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.pipedScript)
  })

  it.each(REDIRECTED_SUBSTITUTIONS)('denies %j', src => {
    expect(checkCommand(src, ctx())).toBe(REASONS.pipedScript)
  })

  it.each(SUBSTITUTION_BENIGN)('allows %j', src => {
    expect(checkCommand(src, ctx())).toBeUndefined()
  })
})

const OUTER_SHELLS: [string, string[]][] = [
  ...SHELLS,
  ...(fs.existsSync('/bin/dash') ? [['/bin/dash', []]] : []),
] as [string, string[]][]

// zsh runs a pipeline's last stage in the shell itself, so there the substitution reads the shell's stdin.
const PIPE_RUNNERS = OUTER_SHELLS.filter(([shell]) => !shell.endsWith('zsh'))

describe.skipIf(SHELLS.length === 0)('real shells run the push a command substitution reads', () => {
  it.each(PIPED_SUBSTITUTIONS.filter(src => HAS_ZSH || !src.includes('zsh')))(
    'bash and dash push for %j',
    src => {
      const pushed = OUTER_SHELLS.filter(([shell, args]) => gitCalls(shell, args, src) === 'push --no-verify')

      expect(pushed.map(([shell]) => shell)).toEqual(PIPE_RUNNERS.map(([shell]) => shell))
    },
  )

  it.each(REDIRECTED_SUBSTITUTIONS)('no shell pushes for %j', src => {
    for (const [shell, args] of OUTER_SHELLS) expect(gitCalls(shell, args, src)).toBe('')
  })

  it.each(SUBSTITUTION_BENIGN)('every shell runs only what the guard read for %j', (src, calls) => {
    for (const [shell, args] of OUTER_SHELLS) expect(gitCalls(shell, args, src)).toMatch(calls)
  })
})
