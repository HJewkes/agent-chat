/**
 * Reads an ssh, scp or sftp argv the way OpenSSH's getopt does (TP-2376), to find an option that
 * makes it run a local program the guard never reads: an `-o` keyword ending in `Command`
 * (ProxyCommand, LocalCommand, KnownHostsCommand and the like), a `-F` config file, which can set
 * any of them, scp's `-S` and `-D`, and sftp's `-S`, `-D` and `-b` (a batch file's `!` lines run
 * locally). Option strings are from OpenSSH 10.2 `ssh.c`, `scp.c` and `sftp.c`.
 */

import { LIVE, unmark } from './shell-words.js'

interface Grammar {
  known: ReadonlySet<string>
  takesValue: ReadonlySet<string>
  /** Letters whose value is a program or a script the program runs locally. */
  runs: ReadonlySet<string>
  /** ssh re-runs getopt once after the host, so its second operand starts the remote command. */
  stopsAfterHost: boolean
}

function grammar(optstring: string, runs: string, stopsAfterHost: boolean): Grammar {
  const letters = [...optstring]
  const known = letters.filter(c => c !== ':')
  const takesValue = letters.filter((c, i) => c !== ':' && letters[i + 1] === ':')
  return { known: new Set(known), takesValue: new Set(takesValue), runs: new Set(runs), stopsAfterHost }
}

const GRAMMARS: ReadonlyMap<string, Grammar> = new Map([
  ['ssh', grammar('1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy', '', true)],
  ['scp', grammar('12346ABCTdfOpqRrstvD:F:J:M:P:S:c:i:l:o:X:', 'SD', false)],
  ['sftp', grammar('1246AafhNpqrvCc:D:i:l:o:s:S:b:B:F:J:P:R:X:', 'SDb', false)],
])

export const SSH_PROGRAMS: ReadonlySet<string> = new Set(GRAMMARS.keys())

/** Config files that set nothing: ssh reads `none` as no file at all. */
const EMPTY_CONFIGS = new Set(['/dev/null', 'none'])

/** An `-o` line's keyword: ssh skips a leading `=` or blank, and quotes are no part of it. */
const keyword = (option: string): string =>
  option
    .replace(/["\\]/g, '')
    .split(/[\s=]+/)
    .find(token => token !== '') ?? ''

function valueRuns(g: Grammar, letter: string, value: string, splits: readonly string[]): boolean {
  if (g.runs.has(letter)) return true
  if (letter === 'o') return value.includes(LIVE) || /command/i.test(keyword(unmark(value)))
  if (letter === 'F') return value.includes(LIVE) || !EMPTY_CONFIGS.has(value)
  return splits.includes(value)
}

/** One `-xyz` cluster: whether it runs a program, and whether it took the next word as its value. */
function readCluster(
  g: Grammar,
  letters: string,
  next: string | undefined,
  splits: readonly string[],
): { runs: boolean; tookNext: boolean } {
  for (const [i, letter] of [...letters].entries()) {
    if (!g.known.has(letter)) return { runs: true, tookNext: false }
    if (!g.takesValue.has(letter)) continue
    const attached = letters.slice(i + 1)
    const value = attached === '' ? next : attached
    return { runs: value !== undefined && valueRuns(g, letter, value, splits), tookNext: attached === '' }
  }
  return { runs: false, tookNext: false }
}

/**
 * Whether `marked` (the words after the program name, with LIVE marks) makes ssh, scp or sftp run a
 * local program. A word in option position the guard cannot read counts, as does a value the shell
 * splits (`splits`), because either may become an option. scp and sftp are read past operands, which
 * costs only a rare false deny. A name that is none of the three runs nothing here.
 */
export function sshRunsLocalProgram(
  name: string,
  marked: readonly string[],
  splits: readonly string[],
): boolean {
  const g = GRAMMARS.get(name)
  if (g === undefined) return false
  let operands = 0
  for (let i = 0; i < marked.length; i++) {
    const word = marked[i] ?? ''
    if (word.includes(LIVE)) return true
    if (word === '--') return false
    if (!word.startsWith('-') || word === '-') {
      operands++
      if (g.stopsAfterHost && operands > 1) return false
      continue
    }
    const read = readCluster(g, word.slice(1), marked[i + 1], splits)
    if (read.runs) return true
    if (read.tookNext) i++
  }
  return false
}
