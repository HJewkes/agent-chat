/**
 * A script one command of a line writes and a later command runs (CC-1340): `printf '...' > s.sh;
 * bash s.sh`. These readers find the text a writer puts in its files, the commands that name a file
 * without changing it, and the words a command runs as script files. Which file is which, and what to
 * deny, is the guard's question. Every reader returns its fail-closed answer for a word the shell
 * expands: no readable text, no kept content, a hidden run.
 */
import path from 'node:path'
import { readShellCall } from './shell-invocation.js'
import { LIVE, unmark, type SimpleCommand } from './shell-words.js'

/** A word a command runs as a script file, and the operands the script reads as its positionals. */
export interface ScriptRun {
  /** A marked word; a head run carries the resolved head, which holds no LIVE. */
  word: string
  args: string[]
  /** Run as the command word, so the kernel reads its `#!` line; `bash F` and `source F` do not. */
  head: boolean
}

/**
 * `stdin`: a shell reads its script from its standard input (`bash`, `bash -s x`, `bash < f`,
 * `cat f | bash`). These readers see no redirect or pipe, so the guard joins the flag with the
 * command's own stdin to learn which text runs.
 */
export type ScriptRuns = { runs: ScriptRun[]; stdin: boolean } | { hidden: true }

const isLive = (word: string): boolean => word.includes(LIVE)

// Each names a file without changing what it holds, when it has no write target of its own.
const KEEPS_CONTENT = new Set(
  'chmod ls stat file test [ wc cat head tail grep diff cmp shellcheck sha256sum md5sum'.split(' '),
)

/**
 * A heredoc or here-string the shell feeds as written: from no pipe, with nothing it expands and no
 * backslash it rewrites. The parser drops a heredoc's final newline, which a command line does not need.
 */
function literalStdin(cmd: SimpleCommand): string | undefined {
  if (cmd.stdinLive || cmd.backslash || cmd.before === '|') return undefined
  return cmd.stdin
}

/** The plain words after the command word, or undefined when any is expanded or spells an option. */
function plainOperands(cmd: SimpleCommand): string[] | undefined {
  const operands = cmd.marked.slice(1)
  if (operands.some(isLive) || unmark(operands[0] ?? '').startsWith('-')) return undefined
  return operands.map(unmark)
}

/**
 * The exact text a command writes to its redirect targets, or `tee` to its operands: a `cat` or `tee`
 * of a literal heredoc, an `echo` of plain words, or a `printf` of one plain format. zsh's `echo` reads
 * escapes and options, and `printf` reads `%` and `\`, so a word holding either is unread. Undefined
 * for any other command, which may write anything.
 */
export function writtenText(cmd: SimpleCommand): string | undefined {
  const name = cmd.marked[0]
  const operands = plainOperands(cmd)
  if (operands === undefined) return undefined
  if (name === 'tee') return teeText(cmd, operands)
  if (cmd.writes.length === 0) return undefined
  if (name === 'cat') return operands.length === 0 ? literalStdin(cmd) : undefined
  if (operands.some(word => word.includes('\\'))) return undefined
  if (name === 'echo') return `${operands.join(' ')}\n`
  if (name === 'printf' && operands.length === 1 && !operands[0]?.includes('%')) return operands[0]
  return undefined
}

/** GNU `tee` reads an option after its files (`tee s -a` appends), so every operand must be plain. */
function teeText(cmd: SimpleCommand, operands: readonly string[]): string | undefined {
  if (operands.some(word => word.startsWith('-'))) return undefined
  return operands.length > 0 || cmd.writes.length > 0 ? literalStdin(cmd) : undefined
}

/**
 * A command that names files without changing what they hold, so a script it names keeps its text.
 * Only a bare command word counts: `./cat s` may be a file the line wrote.
 */
export function keepsContent(cmd: SimpleCommand): boolean {
  const head = cmd.marked[0] ?? ''
  if (isLive(head) || head.includes('/') || cmd.writes.length > 0) return false
  return KEEPS_CONTENT.has(head)
}

/**
 * The words a command runs as script files. `head` is its resolved command word, and `marked` and
 * `assigns` the marked words after it and the `NAME=value` words it runs with. A shell's script and
 * startup file come from `readShellCall`; `source` and `.` run their first operand after an optional
 * `--`; and a command word holding `/` runs itself, even when its base name is a shell, since
 * `./bash` may be a file the line wrote. `shells` names the shells, which the guard owns.
 */
export function scriptRuns(
  head: string,
  marked: readonly string[],
  assigns: readonly string[],
  shells: ReadonlySet<string>,
): ScriptRuns {
  const name = path.basename(head)
  const self: ScriptRun[] = head.includes('/') ? [{ word: head, args: [...marked], head: true }] : []
  if (shells.has(name)) {
    const call = shellRuns(name, marked, assigns)
    return 'hidden' in call ? call : { ...call, runs: [...self, ...call.runs] }
  }
  if (head === 'source' || head === '.') return sourceRuns(marked)
  return { runs: self, stdin: false }
}

function shellRuns(name: string, marked: readonly string[], assigns: readonly string[]): ScriptRuns {
  const call = readShellCall(name, marked, assigns)
  if (call.script.from === 'hidden') return { hidden: true }
  const runs: ScriptRun[] = []
  if (call.rcfile !== undefined) runs.push({ word: marked[call.rcfile] ?? '', args: [], head: false })
  const at = call.script.from === 'file' ? call.script.at : undefined
  if (at !== undefined) runs.push({ word: marked[at] ?? '', args: marked.slice(at + 1), head: false })
  return { runs, stdin: call.script.from === 'stdin' }
}

/** bash's `source -p PATH F` searches a path, and any other option word may hide the file. */
function sourceRuns(marked: readonly string[]): ScriptRuns {
  const at = unmark(marked[0] ?? '') === '--' ? 1 : 0
  const word = marked[at]
  if (word === undefined) return { runs: [], stdin: false }
  if (isLive(word) || (at === 0 && unmark(word).startsWith('-'))) return { hidden: true }
  return { runs: [{ word, args: marked.slice(at + 1), head: false }], stdin: false }
}

// Where the system installs its shells and `env`; a path anywhere else may be a file the line wrote.
const SYSTEM_DIRS = new Set(['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'])

/** The base name of an absolute path in a system directory, or undefined: `/bin/../tmp/sh` is not one. */
function systemProgram(file: string): string | undefined {
  if (!file.startsWith('/') || path.posix.normalize(file) !== file) return undefined
  return SYSTEM_DIRS.has(path.posix.dirname(file)) ? path.posix.basename(file) : undefined
}

/**
 * A `#!` line naming anything but one of `shells` in a system directory, directly or through a system
 * `env`, so running the file as a command hands its text to a reader the guard does not follow. A file
 * with no `#!` line runs under a shell. Any other interpreter path, relative (`#!./bash`, resolved from
 * the current directory) or absolute (`#!/tmp/x/bash`), may be a file the line wrote. `env` with an
 * option (`env -S bash -e`) is foreign, since the split is not read here; a bare name it looks up on PATH.
 */
export function foreignShebang(body: string, shells: ReadonlySet<string>): boolean {
  const first = body.split('\n', 1)[0] ?? ''
  if (!first.startsWith('#!')) return false
  const [interpreter = '', next = ''] = first.slice(2).trim().split(/\s+/)
  const name = systemProgram(interpreter)
  if (name !== 'env') return name === undefined || !shells.has(name)
  if (next.startsWith('-')) return true
  const program = next.includes('/') ? systemProgram(next) : next
  return program === undefined || !shells.has(program)
}
