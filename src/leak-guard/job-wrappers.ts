/**
 * Reads util-linux's setsid, flock, taskset, chrt, script and unshare (CC-1414), and the exec
 * wrappers in EXEC_GETOPTS, busybox setsid and scriptlive (CC-1424), which run a command they are
 * given. Pure: words come in marked (LIVE before what the shell expands).
 * Option tables are from util-linux 2.41. Unlike the guard's other getopt wrappers, an option
 * missing from a table fails closed, since these programs gain options between releases.
 */

import path from 'node:path'

import { expandsToWords } from './git-unresolved.js'
import { LIVE } from './shell-words.js'

interface StrictGetopt {
  /** Short letters that take the rest of the word or the next word as their value. */
  value: string
  /** Short letters that take only a value glued to them, as script's `-t[file]`. */
  glued?: string
  flag: string
  /** Each long name, with whether it takes a value as the next word. */
  long: Readonly<Record<string, boolean>>
  /** getopt permutes, so operands may come before options (script). */
  permute?: boolean
}

const flags = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map(n => [n, false]))
const values = (...names: string[]): Record<string, boolean> => Object.fromEntries(names.map(n => [n, true]))

/**
 * Exec wrappers outside CC-1414 (CC-1424). The short letters are each binary's own getopt string
 * (util-linux 2.41, GNU time 1.9); numactl 2.0.19 keeps none in its binary, so its letters were each
 * run on this host. Letters getopt reads with `::` take only a glued value.
 */
const EXEC_GETOPTS: Readonly<Record<string, StrictGetopt>> = {
  prlimit: {
    value: 'po',
    glued: 'cdefilmnqrstuvxy',
    flag: 'hV',
    long: {
      ...flags('core', 'data', 'nice', 'fsize', 'sigpending', 'memlock', 'rss', 'nofile', 'msgqueue'),
      ...flags('rtprio', 'stack', 'cpu', 'nproc', 'as', 'locks', 'rttime'),
      ...flags('noheadings', 'raw', 'verbose', 'help', 'version'),
      ...values('pid', 'output'),
    },
  },
  time: {
    value: 'fo',
    flag: 'apqvV',
    long: {
      ...flags('append', 'portability', 'quiet', 'verbose', 'help', 'version'),
      ...values('format', 'output-file'),
    },
  },
  numactl: {
    value: 'iwpPcNCmSfoLMI',
    flag: 'ablsHtTuVdD',
    long: {
      ...flags('all', 'show', 'localalloc', 'hardware', 'strict', 'dump', 'dump-nodes', 'huge', 'touch'),
      ...flags('verify', 'balancing', 'version', 'cpu-compress'),
      ...values('interleave', 'weighted-interleave', 'preferred', 'preferred-many', 'cpubind'),
      ...values('cpunodebind', 'physcpubind', 'membind', 'shm', 'file', 'offset', 'length', 'shmmode'),
      ...values('shmid'),
    },
  },
  nsenter: {
    value: 'tNSG',
    glued: 'muinpCUTrwW',
    flag: 'ahVecFZ',
    long: {
      ...flags('all', 'mount', 'uts', 'ipc', 'net', 'pid', 'cgroup', 'user', 'user-parent', 'time'),
      ...flags('preserve-credentials', 'keep-caps', 'root', 'wd', 'wdns', 'env', 'no-fork'),
      ...flags('join-cgroup', 'follow-context', 'help', 'version'),
      ...values('target', 'net-socket', 'setuid', 'setgid'),
    },
  },
  chroot: {
    value: '',
    flag: 'hV',
    long: { ...flags('skip-chdir', 'help', 'version'), ...values('groups', 'userspec') },
  },
  setarch: {
    value: '',
    flag: 'hVv3BFILRSTXZ',
    long: {
      ...flags('32bit', 'fdpic-funcptrs', 'short-inode', 'addr-compat-layout', 'addr-no-randomize'),
      ...flags('whole-seconds', 'sticky-timeouts', 'read-implies-exec', 'mmap-page-zero', '3gb', '4gb'),
      ...flags('uname-2.6', 'verbose', 'list', 'show', 'help', 'version'),
    },
  },
  enosys: {
    value: 'si',
    glued: 'd',
    flag: 'Vhlm',
    long: { ...flags('list', 'list-ioctl', 'dump', 'help', 'version'), ...values('syscall', 'ioctl') },
  },
  uclampset: {
    value: 'pmM',
    flag: 'asRhvV',
    long: {
      ...flags('all-tasks', 'system', 'reset-on-fork', 'verbose', 'help', 'version'),
      ...values('pid'),
    },
  },
  coresched: {
    value: 'sdt',
    flag: 'vVh',
    long: { ...flags('verbose', 'help', 'version'), ...values('source', 'dest', 'dest-type') },
    permute: true,
  },
}

/** busybox's setsid applet: `setsid [-c] PROG ARGS`. */
const BUSYBOX_SETSID: StrictGetopt = { value: '', flag: 'c', long: {} }

const GETOPTS: Readonly<Record<string, StrictGetopt>> = {
  setsid: { value: '', flag: 'cfwhV', long: flags('ctty', 'fork', 'wait', 'help', 'version') },
  flock: {
    value: 'wE',
    flag: 'sexunoFhV',
    long: {
      ...flags('shared', 'exclusive', 'unlock', 'nonblocking', 'nonblock', 'nb', 'close', 'no-fork'),
      ...flags('fcntl', 'verbose', 'help', 'version'),
      ...values('timeout', 'wait', 'conflict-exit-code'),
    },
  },
  taskset: { value: '', flag: 'apchV', long: flags('all-tasks', 'pid', 'cpu-list', 'help', 'version') },
  chrt: {
    value: 'TPD',
    flag: 'bdfiorRamphvV',
    long: {
      ...flags('batch', 'deadline', 'fifo', 'idle', 'other', 'rr', 'reset-on-fork', 'all-tasks', 'max'),
      ...flags('pid', 'verbose', 'help', 'version'),
      ...values('sched-runtime', 'sched-period', 'sched-deadline'),
    },
  },
  script: {
    value: 'IOBTmcEo',
    glued: 't',
    flag: 'aefqhV',
    long: {
      ...flags('append', 'return', 'flush', 'force', 'quiet', 'timing', 'help', 'version'),
      ...values('log-in', 'log-out', 'log-io', 'log-timing', 'logging-format', 'command', 'echo'),
      ...values('output-limit'),
    },
    permute: true,
  },
  unshare: {
    value: 'RwSGl',
    flag: 'muinpUCTrcfhV',
    long: {
      ...flags('mount', 'uts', 'ipc', 'net', 'pid', 'user', 'cgroup', 'time', 'mount-proc', 'mount-binfmt'),
      ...flags('map-root-user', 'map-current-user', 'map-auto', 'fork', 'kill-child', 'keep-caps'),
      ...flags('help', 'version'),
      ...values('load-interp', 'propagation', 'root', 'wd', 'setuid', 'setgid', 'map-user', 'map-group'),
      ...values('map-users', 'map-groups', 'owner', 'setgroups', 'monotonic', 'boottime'),
    },
  },
  ...EXEC_GETOPTS,
}

/** The names util-linux installs setarch under, which take no arch operand. */
const SETARCH_NAMES: ReadonlySet<string> = new Set(['linux32', 'linux64', 'i386', 'x86_64', 'uname26'])

export const JOB_WRAPPERS: ReadonlySet<string> = new Set([
  ...Object.keys(GETOPTS),
  ...SETARCH_NAMES,
  'busybox',
  'scriptlive',
])

/** One option as getopt reads it: a short letter or a full long name, and its value. */
interface Option {
  name: string
  value?: string
}

interface Parsed {
  options: Option[]
  /** Where the operands start; for a permuting getopt, the words left after `--`. */
  end: number
  /** For a permuting getopt, the index of each operand before `end`. */
  operands: number[]
}

/**
 * The words a wrapper runs from `at`, or a `-c` string it runs through `$SHELL -c` (`script`
 * undefined: an interactive shell, which reads stdin). Undefined on an option the table lacks
 * or an option word the shell expands. `chdir` is set when the command may run elsewhere. `splits`
 * holds the marked words the shell may split, as `SimpleCommand.splits` does.
 */
export type JobRun = { at: number; chdir?: boolean } | { script: string | undefined; chdir?: boolean }

export function jobRun(
  words: readonly string[],
  i: number,
  name: string,
  splits: readonly string[] = [],
): JobRun | undefined {
  // scriptlive types a log file the guard never reads into what it runs.
  if (name === 'scriptlive') return undefined
  if (name === 'busybox') return busyboxRun(words, i, splits)
  const arch = name === 'setarch' && !(words[i] ?? '-').startsWith('-')
  if (arch && mayExpand(words[i] as string, splits)) return undefined
  const table = SETARCH_NAMES.has(name) ? 'setarch' : name
  const parsed = readOptions(words, arch ? i + 1 : i, GETOPTS[table] as StrictGetopt, splits)
  if (parsed === undefined) return undefined
  const { options, end } = parsed
  if (name === 'script') return scriptText(options.filter(o => o.name === 'command').at(-1)?.value)
  // Each runs a shell when given no command: unshare and nsenter `$SHELL`, setarch /bin/sh.
  if (name === 'unshare' || name === 'nsenter') return orShell(words, end, true)
  if (table === 'setarch') return orShell(words, end, false)
  if (name === 'chroot') return chrootRun(words, end, splits)
  if (name === 'coresched') return coreschedRun(words, parsed)
  if (name === 'flock' || name === 'taskset' || name === 'chrt') return afterOperand(words, end, name, splits)
  return { at: end }
}

const orShell = (words: readonly string[], end: number, chdir: boolean): JobRun =>
  end < words.length ? { at: end, chdir } : { script: undefined, chdir }

/**
 * busybox 1.37's applets the guard reads as the command they name (CC-1342): its shells, and env,
 * timeout and xargs, whose options are a subset of the GNU ones and which stop at the first operand.
 */
const BUSYBOX_COMMANDS: ReadonlySet<string> = new Set(['sh', 'ash', 'env', 'timeout', 'xargs'])

/**
 * busybox runs the applet its first word names, by basename (`busybox /bin/sh` runs sh). setsid is
 * read here, BUSYBOX_COMMANDS run as the command they name, and any other applet fails closed.
 */
function busyboxRun(words: readonly string[], i: number, splits: readonly string[]): JobRun | undefined {
  const applet = words[i]
  if (applet === undefined || mayExpand(applet, splits)) return undefined
  if (BUSYBOX_COMMANDS.has(path.basename(applet))) return { at: i }
  if (applet !== 'setsid') return undefined
  const parsed = readOptions(words, i + 1, BUSYBOX_SETSID, splits)
  return parsed && { at: parsed.end }
}

/**
 * chroot's first operand is the new root; with no command after it, it runs `$SHELL -i`. uutils'
 * chroot may read an option after the root, so a command word starting with `-` fails closed.
 */
function chrootRun(words: readonly string[], end: number, splits: readonly string[]): JobRun | undefined {
  const root = words[end]
  if (root === undefined) return { at: end }
  if (mayExpand(root, splits) || words[end + 1]?.startsWith('-') === true) return undefined
  return orShell(words, end + 1, true)
}

/**
 * coresched permutes: its first operand is the function (get, new or copy) and the rest are the
 * command. Only a command that ends the words and has no option among it is read.
 */
function coreschedRun(words: readonly string[], { operands, end }: Parsed): JobRun | undefined {
  const afterDashes = words.slice(end).map((_, k) => end + k)
  const [, first, ...more] = [...operands, ...afterDashes]
  if (first === undefined) return { at: words.length }
  return more.every((at, k) => at === first + k + 1) && first + more.length === words.length - 1
    ? { at: first }
    : undefined
}

const CHRT_PRIORITY = /^\s*[+-]?\d+$/

/**
 * Whether the shell may turn a word the walk reads to find the command into an option, `--`, or
 * none or several words, which moves where the command starts. One word that starts with a literal
 * other than `-`, or with `~/`, cannot become an option.
 */
export const mayExpand = (word: string, splits: readonly string[]): boolean =>
  word.includes(LIVE) &&
  (expandsToWords(word, splits) ||
    word.startsWith('-') ||
    (word.startsWith(LIVE) && !word.startsWith(`${LIVE}~/`)))

/** A `-c` text to check as `sh -c`; like any script, text the shell expands cannot be read as one. */
const scriptText = (text: string | undefined): JobRun | undefined =>
  text?.includes(LIVE) === true ? undefined : { script: text }

/**
 * flock, taskset and chrt take one operand before the command: a lock file, a CPU mask, a
 * priority. With -p the pid is the last word, and pid 0 runs the command, so -p reads the same.
 * A word the shell expands may be none or several, so the command may start at it or after it.
 */
function afterOperand(
  words: readonly string[],
  end: number,
  name: string,
  splits: readonly string[],
): JobRun | undefined {
  const operand = words[end]
  if (operand === undefined) return { at: end }
  const script = name === 'flock' ? flockScript(words[end + 1], words[end + 2], splits) : null
  if (script !== null) return script
  // Reading only the operand as the command would leave the words after it unread.
  if (operand.includes(LIVE)) return undefined
  // chrt reads the priority with strtoimax; a version that drops it for SCHED_OTHER would run any other word.
  if (name === 'chrt' && !CHRT_PRIORITY.test(operand)) return { at: end }
  // chrt, unlike taskset and flock, skips one `--` after the priority.
  return { at: name === 'chrt' && words[end + 1] === '--' ? end + 2 : end + 1 }
}

/** The text after flock's `-c`, whatever its lock file; null when no `-c` follows the file. */
function flockScript(
  flag: string | undefined,
  next: string | undefined,
  splits: readonly string[],
): JobRun | undefined | null {
  if (flag !== undefined && mayExpand(flag, splits)) return undefined
  const glued = flag?.startsWith('--command=') === true ? flag.slice('--command='.length) : undefined
  if (glued === undefined && flag !== '-c' && flag !== '--command') return null
  return scriptText(glued ?? next ?? '')
}

function readOptions(
  words: readonly string[],
  i: number,
  spec: StrictGetopt,
  splits: readonly string[],
): Parsed | undefined {
  const options: Option[] = []
  const operands: number[] = []
  for (; i < words.length; i++) {
    const word = words[i] as string
    if (mayExpand(word, splits)) return undefined
    // The word after `--` places the operand or command as much as any word before it.
    if (word === '--')
      return mayExpand(words[i + 1] ?? '', splits) ? undefined : { options, end: i + 1, operands }
    if (!word.startsWith('-') || word === '-') {
      // A permuting getopt reads options anywhere, so it reads on past an operand.
      if (spec.permute !== true) return { options, end: i, operands }
      operands.push(i)
      continue
    }
    const read = word.startsWith('--') ? longOption(word.slice(2), spec) : cluster(word.slice(1), spec)
    if (read === undefined) return undefined
    for (const option of read.options) options.push(option)
    if (read.next) {
      const value = words[++i] ?? ''
      // The shell may split an expanded value into words that move the operands.
      if (mayExpand(value, splits)) return undefined
      options.push({ name: read.next, value })
    }
  }
  return { options, end: words.length, operands }
}

/** An option read from one word; `next` names the option that takes the following word. */
interface Read {
  options: Option[]
  next?: string
}

/** A long name as getopt_long resolves it: exact, or a prefix of exactly one name. */
function longOption(body: string, spec: StrictGetopt): Read | undefined {
  const eq = body.indexOf('=')
  const given = eq < 0 ? body : body.slice(0, eq)
  const names = given in spec.long ? [given] : Object.keys(spec.long).filter(n => n.startsWith(given))
  const name = names[0]
  if (given === '' || name === undefined || names.length > 1) return undefined
  if (eq >= 0) return { options: [{ name, value: body.slice(eq + 1) }] }
  return spec.long[name] === true ? { options: [], next: name } : { options: [{ name }] }
}

const LONG_OF: Readonly<Record<string, string>> = { c: 'command', p: 'pid' }

function cluster(letters: string, spec: StrictGetopt): Read | undefined {
  const options: Option[] = []
  for (let k = 0; k < letters.length; k++) {
    const letter = letters[k] as string
    const name = LONG_OF[letter] ?? letter
    const rest = letters.slice(k + 1)
    if (spec.value.includes(letter))
      return rest === '' ? { options, next: name } : { options: [...options, { name, value: rest }] }
    if (spec.glued?.includes(letter) === true) return { options: [...options, { name, value: rest }] }
    if (!spec.flag.includes(letter)) return undefined
    options.push({ name })
  }
  return { options }
}
