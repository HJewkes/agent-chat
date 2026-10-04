import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkCommand, readText, type GuardContext } from '../leak-guard/pretool.js'

/**
 * Runs each command through the guard and then through real shells with a fake `gh` that
 * records what it is given. The property: whenever the guard allows, no shell posts the term.
 * No real gh can run: PATH holds the fake first, and the suite aborts unless each shell finds it.
 */

// Synthetic only.
const TERM = 'zebraquark'
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-pretool-shells-')))
const BIN = path.join(ROOT, 'bin')
const WORK = path.join(ROOT, 'work')
const RECORD = path.join(ROOT, 'posted')
const ENV = {
  PATH: `${BIN}:/usr/bin:/bin`,
  HOME: path.join(ROOT, 'home'),
  TMPDIR: WORK,
  GH_HOST: 'gh.invalid',
  GH_TOKEN: 'invalid',
  GH_CONFIG_DIR: path.join(ROOT, 'home'),
  RECORD,
}

const FAKE_GH = `#!/bin/sh
# Records what gh would be given: its arguments, its stdin and every file an argument names.
{
  printf '%s\\n' "$@"
  cat
  for arg in "$@"; do
    value=\${arg#*=}
    for file in "$arg" "$value" "\${value#@}"; do
      if [ -f "$file" ]; then cat "$file"; fi
    done
  done
} >> "$RECORD"
`
const DIST = path.resolve(import.meta.dirname, '../../dist')
const REAL_BIN = path.join(ROOT, 'real-bin')
const TERMS = path.join(ROOT, 'private-terms')
const REAL_ENV = { ...ENV, PATH: `${REAL_BIN}:${BIN}:/usr/bin:/bin` }

// The built gh-write scanner and runner, over a synthetic term list and the fake gh on PATH.
const REAL_DRIVER = `import { runGhWrite, runGh } from ${JSON.stringify(path.join(DIST, 'cli/gh-write.js'))}
import { scanDeps } from ${JSON.stringify(path.join(DIST, 'gh-write/scan.js'))}
const args = process.argv.slice(2)
const result = await runGhWrite(args.slice(args[0] === '--' ? 1 : 0), scanDeps(${JSON.stringify(TERMS)}), {
  now: Date.now,
  sleep: () => Promise.resolve(),
  runGh,
  coreRemaining: () => Promise.resolve(undefined),
  notice: () => undefined,
  lockDir: ${JSON.stringify(path.join(ROOT, 'lock'))},
  stampPath: ${JSON.stringify(path.join(ROOT, 'stamp'))},
  gapMs: 0,
})
process.exitCode = result.code
`
const REAL_AGENT_CHAT = `#!/bin/sh
shift
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(REAL_BIN, 'driver.mjs'))} "$@"
`
const FAKE_AGENT_CHAT = `#!/bin/sh
shift
if [ "$1" = "--" ]; then shift; fi
exec gh "$@"
`

const SHELLS: [string, string[]][] = (
  [
    ['/bin/zsh', ['-f']],
    ['/bin/bash', ['--noprofile', '--norc']],
  ] satisfies [string, string[]][]
).filter(([shell]) => fs.existsSync(shell))

const BASH = SHELLS.find(([shell]) => shell.endsWith('bash'))

const inShell = (
  shell: string,
  flags: string[],
  command: string,
  env: Record<string, string> = ENV,
  cwd = WORK,
): string => {
  try {
    return execFileSync(shell, [...flags, '-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 10_000,
    })
  } catch {
    return ''
  }
}

/** What each shell's fake gh recorded for one command. */
function posted(command: string, env: Record<string, string> = ENV, cwd = WORK): string[] {
  return SHELLS.map(([shell, flags]) => {
    fs.writeFileSync(RECORD, '')
    inShell(shell, flags, command, env, cwd)
    return fs.readFileSync(RECORD, 'utf8')
  })
}

const guard = (over: Partial<GuardContext> = {}): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: WORK,
  env: ENV,
  protectedPaths: [],
  readFile: readText,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  ...over,
})

beforeAll(() => {
  for (const dir of [BIN, REAL_BIN, WORK, ENV.HOME, path.join(ROOT, 'evil')]) fs.mkdirSync(dir)
  fs.writeFileSync(TERMS, `${TERM}\n`)
  fs.writeFileSync(path.join(REAL_BIN, 'driver.mjs'), REAL_DRIVER)
  writeHijacks()
  writeRepo()
  fs.writeFileSync(path.join(REAL_BIN, 'agent-chat'), REAL_AGENT_CHAT, { mode: 0o755 })
  fs.writeFileSync(path.join(BIN, 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(path.join(BIN, 'agent-chat'), FAKE_AGENT_CHAT, { mode: 0o755 })
  fs.writeFileSync(path.join(ROOT, 'evil', 'pr.md'), `${TERM}\n`)
  fs.writeFileSync(path.join(WORK, 'pr.md'), 'clean file\n')
  fs.symlinkSync(INSTALL, path.join(WORK, 'link.md'))
  fs.writeFileSync(path.join(WORK, 'ab.md'), 'clean file\n')
  fs.writeFileSync(path.join(WORK, 'a\x01b.md'), `${TERM}\n`)
  for (const [shell, flags] of SHELLS) {
    const found = inShell(shell, flags, 'command -v gh').trim()
    if (found !== path.join(BIN, 'gh')) throw new Error(`${shell} resolves gh to ${found}, not the fake`)
  }
})

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const EVIL = 'cat ../evil/pr.md'
const CREATE = 'gh pr create -t x -F -'
const HEREDOC = "<<'EOF'\nclean\nEOF"
const FROM_FILE = 'pr create -t x --body-file ../evil/pr.md'

const COMMENT = 'gh pr comment 1 -F -'
const OPEN3 = '3< ../evil/pr.md'
const COMMENTS = 'gh api -X POST repos/o/r/issues/1/comments'

// bash copies descriptor 3 onto stdin after the heredoc, so gh reads the file; zsh refuses the copy.
const COPIED_ONTO_STDIN = [
  `${COMMENT} <<'EOF' ${OPEN3} 0>&3\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} 0>&3-\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} 0>& 3\nclean\nEOF`,
  `${COMMENT} <<'EOF' 3<> ../evil/pr.md 0>&3\nclean\nEOF`,
  `exec ${OPEN3}; ${COMMENT} <<'EOF' 0>&3\nclean\nEOF`,
  `${COMMENT} <<< clean ${OPEN3} 0>&3`,
  `${COMMENT} 0<<'EOF' ${OPEN3} 0>&3\nclean\nEOF`,
  `${COMMENTS} --input - <<'EOF' ${OPEN3} 0>&3\nclean\nEOF`,
  `${COMMENTS} -F body=@- <<'EOF' ${OPEN3} 0>&3\nclean\nEOF`,
  `agent-chat gh-write -- pr comment 1 -F - <<'EOF' ${OPEN3} 0>&3\nclean\nEOF`,
]

// CC-347: every shell runs gh here, behind a wrapper or option the guard used to stop at.
const HIDDEN_BEHIND_OPTION = [
  `W=nice; $W -n 5 gh ${FROM_FILE}`,
  `W=env; $W -u X gh ${FROM_FILE}`,
  `OPT=-u; env $OPT X gh ${FROM_FILE}`,
  `exec -a name gh ${FROM_FILE}`,
  `function f { gh ${FROM_FILE}; }; f`,
]

const DENIED = [
  ...COPIED_ONTO_STDIN,
  ...HIDDEN_BEHIND_OPTION,
  `${COMMENT} <<'EOF' ${OPEN3} 0<&3\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} <&3\nclean\nEOF`,
  `${COMMENT} <<'EOF' 0<> ../evil/pr.md\nclean\nEOF`,
  `${COMMENT} <<'EOF' < <(${EVIL})\nclean\nEOF`,
  `${COMMENT} <<< ${TERM} <<< clean`,
  `${COMMENT} <<'EOF' 03<<'E2'\nclean\nEOF\n${TERM}\nE2`,
  `${EVIL} | ${COMMENT} 1${HEREDOC}`,
  `${EVIL} |& ${COMMENT} ${HEREDOC}`,
  `${EVIL} | ${CREATE} ${HEREDOC}`,
  `${EVIL} | ${CREATE} <<< clean`,
  `${EVIL} | gh api -X POST repos/o/r/issues/1/comments --input - ${HEREDOC}`,
  `${EVIL} | gh api -X POST repos/o/r/issues/1/comments -F body=@- ${HEREDOC}`,
  `${EVIL} | agent-chat gh-write -- pr create -t x -F - ${HEREDOC}`,
  `${EVIL} | command ${CREATE} ${HEREDOC}`,
  `${EVIL} | { ${CREATE} ${HEREDOC}\n}`,
  `${EVIL} | (${CREATE} ${HEREDOC}\n)`,
  `${EVIL} | ${CREATE} 0${HEREDOC}`,
  `${EVIL} | ${CREATE} 3${HEREDOC}`,
  `${EVIL} | ${CREATE} 3<<< clean`,
  `${CREATE} <<EOF\nzebra\\\nquark\nEOF`,
  `gh pr create -t x -b "$(cat <<EOF\nzebra\\\nquark\nEOF\n)"`,
  `gh pr create -t x -b "$(cat <<'EOF'\nzebra\\\nquark\nEOF\n)"`,
  `gh pr create -t x -b "\`cat <<'EOF'\nzebra\\\nquark\nEOF\n\`"`,
  `gh pr create -t x -b "\`cat <<'EOF'\nzebra\\\\quark\nEOF\n\`"`,
  `echo "$(${CREATE} <<'EOF'\nzebra\\\nquark\nEOF\n)"`,
  `${CREATE} <<'EOF' 12< ../evil/pr.md\nclean\nEOF`,
  `${CREATE} <<'EOF' 12<<'E2'\nclean\nEOF\n${TERM}\nE2`,
  `${CREATE} <<'A' <<'B'\n${TERM}\nA\ns\nB`,
  `${CREATE} <<'A' <<< s\n${TERM}\nA`,
  'gh pr create -t x --body-file a\x01b.md',
  `G=gh; $G ${FROM_FILE}`,
  `$(command -v gh) ${FROM_FILE}`,
  `C='gh ${FROM_FILE}'; eval "$C"`,
  `noglob gh ${FROM_FILE}`,
  `$E gh ${FROM_FILE}`,
  `$(true) gh ${FROM_FILE}`,
  `$E command gh ${FROM_FILE}`,
  `$E agent-chat gh-write -- ${FROM_FILE}`,
  `repeat 1 gh ${FROM_FILE}`,
  `caffeinate gh ${FROM_FILE}`,
  `export TMP""DIR=$HOME/../evil; gh pr create -t x --body-file "$TMPDIR/pr.md"`,
]

// The guard may allow these; the shells show whether what it read is what gh was given.
const NESTED = [
  `${COMMENT} ${OPEN3} 0>&3 <<'EOF'\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} 00>&3\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} 0\\\n>&3\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} 0<&3-\nclean\nEOF`,
  `${COMMENT} <<'EOF' ${OPEN3} "0">&3\nclean\nEOF`,
  `{ ${COMMENT} <<'EOF'\nclean\nEOF\n} ${OPEN3} 0>&3`,
  `{ ${COMMENT} 0>&3; } <<'EOF' ${OPEN3}\nclean\nEOF`,
  `exec ${OPEN3} 0>&3; ${COMMENT} <<'EOF'\nclean\nEOF`,
  `${EVIL} | { true && ${CREATE} ${HEREDOC}\n}`,
  `${EVIL} | while read -r line; do ${CREATE} ${HEREDOC}\ndone`,
  `${EVIL} | if true; then ${CREATE} ${HEREDOC}\nfi`,
  `${CREATE} <<'EOF' 3<<'E2'\nclean\nEOF\n${TERM}\nE2`,
  `exec 3< ../evil/pr.md; ${CREATE} ${HEREDOC}`,
  `${CREATE} <<'EOF' 3< ../evil/pr.md\nclean\nEOF`,
  `${CREATE} <<'EOF'\nzebra\\\nquark\nEOF`,
  `(${CREATE} <<'EOF'\nzebra\\\nquark\nEOF\n)`,
  `{ ${CREATE} <<'EOF'\nzebra\\\nquark\nEOF\n}`,
  `gh pr create -t x -b 'zebra\\\nquark'`,
  `gh pr create -t x -b "$(printf %s 'zebra\\\nquark')"`,
]

const ALLOWED: [string, string][] = [
  [`${CREATE} <<'EOF'\nclean body\nEOF`, 'clean body'],
  [`${CREATE} 0<<'EOF'\nclean body\nEOF`, 'clean body'],
  [`${CREATE} <<EOF\nclean body\nEOF`, 'clean body'],
  ['gh pr create -t x --body-file pr.md', 'clean file'],
  ['gh pr create -t x --body-file "$TMPDIR/pr.md"', 'clean file'],
  [`gh pr create -t x -b "$(cat <<'EOF'\nclean body\nEOF\n)"`, 'clean body'],
  ['gh api -X POST repos/{owner}/{repo}/issues/1/comments -f body=hello', 'repos/{owner}/{repo}/issues/1'],
  ['agent-chat gh-write -- pr create -t x --body-file pr.md', 'clean file'],
]

describe.skipIf(SHELLS.length === 0)('the guard against real shells and a fake gh', () => {
  it.each(DENIED)('denies %j', command => {
    expect(checkCommand(command, guard())).toBeDefined()
  })

  it.each([...DENIED, ...NESTED])('never allows %j while a shell posts the term', command => {
    const allowed = checkCommand(command, guard()) === undefined
    const leaked = posted(command).some(text => text.includes(TERM))

    expect(allowed && leaked).toBe(false)
  })

  it('sees a leak when there is one: every shell posts a pipe that a descriptor-3 heredoc does not replace', () => {
    for (const record of posted(`${EVIL} | ${CREATE} 3${HEREDOC}`)) expect(record).toContain(TERM)
  })

  it.each(HIDDEN_BEHIND_OPTION)('sees a leak when there is one: every shell posts %j', command => {
    const records = posted(command)

    expect(records).toHaveLength(SHELLS.length)
    for (const record of records) expect(record).toContain(TERM)
  })

  it.skipIf(BASH === undefined).each(COPIED_ONTO_STDIN)(
    'sees a leak when there is one: bash posts %j',
    command => {
      fs.writeFileSync(RECORD, '')
      inShell(...(BASH as [string, string[]]), command)

      expect(fs.readFileSync(RECORD, 'utf8')).toContain(TERM)
    },
  )

  it.each(ALLOWED)('allows %j and every shell posts what the guard read', (command, text) => {
    expect(checkCommand(command, guard())).toBeUndefined()
    for (const record of posted(command)) expect(record).toContain(text)
  })
})

// CC-680: a hostile variable behind a quoted endpoint stays one word, so gh gets no method or field flag.
const API_READS = [
  'gh api "repos/o/r/commits/$SHA/check-runs"',
  'gh api "repos/o/r/commits/${SHA}/check-runs" --jq .check_runs',
  'gh api --paginate "repos/o/r/commits/$SHA/check-runs" -q "$SHA"',
]
const HOSTILE = `x -X POST -f body=${TERM}`

describe.skipIf(SHELLS.length === 0)('gh api reads against real shells (CC-680)', () => {
  it.each(API_READS)('allows %j and no shell gives gh a method or field flag', command => {
    expect(checkCommand(command, guard())).toBeUndefined()
    for (const record of posted(command, { ...ENV, SHA: HOSTILE })) {
      const args = record.split('\n').filter(line => line.startsWith('-'))
      expect(args.filter(arg => /^-[XfF]|^--(method|field|raw-field|input)/.test(arg))).toEqual([])
    }
  })
})

// CC-678: the guard defers these to the run-time scan in gh-write; each carries the term past the guard.
const POST = 'agent-chat gh-write -- pr create -t x'
const DEFERRED = [
  `${POST} -b "$(cat < ../evil/pr.md)"`,
  `cat ../evil/pr.md > out.md; ${POST} --body-file out.md`,
  `cat ../evil/pr.md > out.md && ${POST} -F out.md`,
  `${EVIL} | ${POST} -F -`,
  `${EVIL} | ${POST} --body-file -`,
  `${EVIL} 2>/dev/null | ${POST} -F -`,
  `${EVIL} | ${POST} -F - 2>/dev/null`,
]
const EVIL_BIN = path.join(ROOT, 'evil-bin')
const EVIL_FN = path.join(ROOT, 'evil-fn')
const EVIL_ZSH = path.join(ROOT, 'evil-zsh')
const EVIL_HOME = path.join(ROOT, 'evil-home')
const LEAK = 'gh pr create -t x --body-file ../evil/pr.md'
const RAW = `${BIN}:/usr/bin:/bin`

/** Each place a shell could find an `agent-chat` that posts the term itself, ahead of the real one. */
function writeHijacks(): void {
  for (const dir of [EVIL_BIN, EVIL_FN, EVIL_ZSH, EVIL_HOME]) fs.mkdirSync(dir)
  fs.writeFileSync(path.join(EVIL_BIN, 'agent-chat'), `#!/bin/sh\n${LEAK}\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(EVIL_FN, 'agent-chat'), `${LEAK}\n`)
  fs.writeFileSync(path.join(ROOT, 'setup'), `agent-chat() { ${LEAK}; }\n`)
  fs.copyFileSync(path.join(ROOT, 'setup'), path.join(EVIL_ZSH, '.zshenv'))
  fs.copyFileSync(path.join(ROOT, 'setup'), path.join(EVIL_HOME, '.bash_profile'))
}

const GW = 'agent-chat gh-write -- pr create -t x -b "$(cat < ../evil/pr.md)"'
const HIJACKS = [
  `hash -p ${EVIL_BIN}/agent-chat agent-chat; ${GW}`,
  `builtin hash -p ${EVIL_BIN}/agent-chat agent-chat; ${GW}`,
  `bash -c "hash -p ${EVIL_BIN}/agent-chat agent-chat; ${GW.replaceAll('"', '\\"')}"`,
  `hash agent-chat=${EVIL_BIN}/agent-chat; ${GW}`,
  `path=(${EVIL_BIN} ${BIN} /usr/bin /bin); ${GW}`,
  `V=PA; export \${V}TH=${EVIL_BIN}:${RAW}; ${GW}`,
  `V=PA; declare -x \${V}TH=${EVIL_BIN}:${RAW}; ${GW}`,
  `V=PA; read \${V}TH <<< ${EVIL_BIN}:${RAW}; ${GW}`,
  `V=PA; printf -v \${V}TH %s ${EVIL_BIN}:${RAW}; ${GW}`,
  `fpath=(${EVIL_FN}); autoload agent-chat; ${GW}`,
  `agent-chat gh-write() { ${LEAK}; }; ${GW}`,
  `agent-chat x() { ${LEAK}; }; ${GW}`,
  `BASH_ENV=${ROOT}/setup bash -c '${GW}'`,
  `ZDOTDIR=${EVIL_ZSH} zsh -c '${GW}'`,
  `HOME=${EVIL_HOME} bash -l -c '${GW}'`,
]
const REPO = path.join(ROOT, 'repo')
const SWAP = path.join(ROOT, 'evil', 'swap.sh')
const GIT_ENV = { ...ENV, GIT_CONFIG_NOSYSTEM: '1' }

/** A scratch repo whose origin is a local bare repo: the probes that run git never leave ROOT. */
function writeRepo(): void {
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: ROOT, env: GIT_ENV })
  git('init', '-q', '--bare', path.join(ROOT, 'origin.git'))
  git('init', '-q', REPO)
  git('-C', REPO, 'remote', 'add', 'origin', path.join(ROOT, 'origin.git'))
  fs.mkdirSync(path.join(ROOT, 'evil'), { recursive: true })
  fs.writeFileSync(SWAP, `#!/bin/sh\ncp ${EVIL_BIN}/agent-chat ${INSTALL}\n`, { mode: 0o755 })
}

const PIPED = 'cat ../evil/pr.md | agent-chat gh-write -- pr create -t x -F -'
const SETUP_FN = `agent-chat() { ${LEAK}; }`
const INSTALL = path.join(REAL_BIN, 'agent-chat')
// A startup file or the install itself written earlier on the line, then read or run by a later command.
const WRITTEN = [
  `echo '${SETUP_FN}' > ~/.zshenv; zsh -c '${PIPED}'`,
  `echo '${SETUP_FN}' | tee ~/.zshenv; zsh -c '${PIPED}'`,
  `cat ${ROOT}/setup > $HOME/.zshenv; zsh -c '${PIPED}'`,
  `printf '#!/bin/sh\\n${LEAK}\\n' > ${INSTALL}; ${PIPED}`,
  `echo '${LEAK}' > ${INSTALL}; ${PIPED}`,
  `: > ${INSTALL}; echo '${LEAK}' | tee -a ${INSTALL}; ${PIPED}`,
  `printf '#!/bin/sh\\n${LEAK}\\n' &> ${INSTALL}; ${PIPED}`,
  `printf '#!/bin/sh\\n${LEAK}\\n' >& ${INSTALL}; ${PIPED}`,
  `printf '#!/bin/sh\\n${LEAK}\\n' >| ${INSTALL}; ${PIPED}`,
]

const S3 = `printf '#!/bin/sh\\n${LEAK}\\n'`
const TWO = (args: string): string => `cat ${ROOT}/evil/pr.md | agent-chat gh-write -- ${args}`
const R3 = [
  `${S3} > ${INSTALL}; ${TWO(`pr create -t x -F ${INSTALL} -F -`)}`,
  `${S3} > ${INSTALL}; ${TWO(`pr create -t x --body-file ${INSTALL} --body-file -`)}`,
  `${S3} | tee ${INSTALL}; ${TWO(`pr create -t x -F ${INSTALL} -F -`)}`,
  `cd ${REAL_BIN}; ${S3} > agent-chat; ${TWO('pr create -t x -F agent-chat -F -')}`,
  `${S3} > link.md; ${TWO('pr create -t x -F link.md -F -')}`,
  `${S3} > link.md; ${TWO('pr create -t x -F link.md')}`,
  `${S3} > ${INSTALL}; ${TWO(`pr comment 1 -F ${INSTALL} -F -`)}`,
  `${S3} > ${INSTALL}; ${TWO(`api -X POST repos/o/r/issues/1/comments -F body=@${INSTALL} --input -`)}`,
  `${S3} > ${INSTALL}; ${TWO('pr create -t x -F -')}`,
]
const R3_ALL = [...R3, ...R3.map(line => `sh -c "${line}"`)]
const GIT_CONFIG_LINE = `printf '[core]\\n\\tfsmonitor = ${SWAP}\\n' >> .git/config; git status; ${TWO('pr create -t x -F .git/config -F -')}`

// These only hijack zsh; a host without zsh cannot show the leak, and the guard must still deny.
const ZSH_ONLY = /^(?:hash agent-chat=|path=|fpath=|agent-chat (?:gh-write|x)\(\)|ZDOTDIR=)/
const SHADOWS = [
  `agent-chat() { cat; }; ${EVIL} | ${POST} -F -`,
  `alias agent-chat=cat; ${EVIL} | agent-chat gh-write -- pr create -t x -F -`,
  `PATH=${BIN}:$PATH; ${EVIL} | ${POST} -F -`,
  `${EVIL} | ./agent-chat gh-write -- pr create -t x -F -`,
  `${EVIL} | command ${POST} -F -`,
  `${EVIL} | env ${POST} -F -`,
]

describe.skipIf(SHELLS.length === 0)('gh-write deferral against real shells (CC-678)', () => {
  const owned = (): GuardContext =>
    guard({ env: REAL_ENV, scansGhWrite: true, install: { file: INSTALL, dir: REAL_BIN } })

  it.each(DEFERRED)('allows %j and no shell posts the term', command => {
    fs.rmSync(path.join(WORK, 'out.md'), { force: true })
    expect(checkCommand(command, owned())).toBeUndefined()
    for (const record of posted(command, REAL_ENV)) expect(record).not.toContain(TERM)
  })

  it('posts clean text through the same deferred forms', () => {
    const clean = `cat pr.md | ${POST} -F -`
    expect(checkCommand(clean, owned())).toBeUndefined()
    for (const record of posted(clean, REAL_ENV)) expect(record).toContain('clean file')
  })

  it.each(HIJACKS)('denies %j, which posts the term when run', command => {
    expect(checkCommand(command, owned())).toBeDefined()
    const runnable = ZSH_ONLY.test(command) ? SHELLS.some(([shell]) => shell.endsWith('zsh')) : true
    if (runnable) expect(posted(command, REAL_ENV).some(record => record.includes(TERM))).toBe(true)
  })

  it.each(WRITTEN)('denies %j, which posts the term when run', command => {
    const restore = (): void => {
      fs.writeFileSync(INSTALL, REAL_AGENT_CHAT, { mode: 0o755 })
      fs.rmSync(path.join(ENV.HOME, '.zshenv'), { force: true })
    }
    restore()
    expect(checkCommand(command, owned())).toBeDefined()
    const runnable = !command.includes('zsh -c') || SHELLS.some(([shell]) => shell.endsWith('zsh'))
    if (runnable) expect(posted(command, REAL_ENV).some(record => record.includes(TERM))).toBe(true)
    restore()
  })

  it.each(R3_ALL)('denies %j, which posts the term when run', command => {
    const restore = (): void => fs.writeFileSync(INSTALL, REAL_AGENT_CHAT, { mode: 0o755 })
    restore()
    expect(checkCommand(command, owned())).toBeDefined()
    expect(posted(command, REAL_ENV).some(record => record.includes(TERM))).toBe(true)
    restore()
  })

  it('denies a body file that is git config, whose fsmonitor swaps in the install', () => {
    const config = fs.readFileSync(path.join(REPO, '.git', 'config'), 'utf8')
    const restore = (): void => {
      fs.writeFileSync(INSTALL, REAL_AGENT_CHAT, { mode: 0o755 })
      fs.writeFileSync(path.join(REPO, '.git', 'config'), config)
    }
    restore()
    expect(checkCommand(GIT_CONFIG_LINE, { ...owned(), cwd: REPO })).toBeDefined()
    expect(posted(GIT_CONFIG_LINE, REAL_ENV, REPO).some(record => record.includes(TERM))).toBe(true)
    restore()
  })

  it('defers a heredoc body file the same line writes and posts it through gh-write', () => {
    fs.rmSync(path.join(WORK, 'body.md'), { force: true })
    const command = `cat > body.md <<'EOF'\nclean body\nEOF\nagent-chat gh-write -- pr create -t T -F body.md`

    expect(checkCommand(command, owned())).toBeUndefined()
    for (const record of posted(command, REAL_ENV)) expect(record).toContain('clean body')
  })

  it.each(SHADOWS)('denies %j', command => {
    expect(checkCommand(command, owned())).toBeDefined()
  })
})
