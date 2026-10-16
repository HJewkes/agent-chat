import path from 'node:path'
import { LIVE, unmark, type SimpleCommand } from './shell-words.js'

/**
 * What a command may read on stdin: every text it may be fed, or 'unknown' when some source is
 * one the guard cannot read (a program's output, an expansion). Text piped into a shell is a
 * script (CC-1393), so it is checked like a `-c` string.
 *
 * The printing rules are a strict subset of tool-guard's `printedText` (TP-2696): only output
 * that bash, zsh and sh print alike is read, and anything else is 'unknown'. Swap this for
 * tool-guard's export once it ships one that takes string words (CC-1401).
 */
export type Feed = { texts: readonly string[] } | 'unknown'

export const NOTHING: Feed = { texts: [] }

export const joinFeeds = (a: Feed, b: Feed): Feed =>
  a === 'unknown' || b === 'unknown' ? 'unknown' : { texts: [...a.texts, ...b.texts] }

/** echo's text when no word is an option and none holds a backslash, the two places bash and zsh differ. */
function echoText(args: readonly string[]): string | undefined {
  if (args[0]?.startsWith('-') || args.some(arg => arg.includes('\\'))) return undefined
  return `${args.join(' ')}\n`
}

/** printf's text for a format with no directive and no escape other than `\n`. */
function printfText([format, ...rest]: readonly string[]): string | undefined {
  if (format === undefined || format.startsWith('-') || format.includes('%')) return undefined
  if (rest.length > 0 || format.replaceAll('\\n', '').includes('\\')) return undefined
  return format.replaceAll('\\n', '\n')
}

/** The text a plain `echo` or `printf` prints, or undefined for any other command or a word the shell expands. */
function printed(cmd: SimpleCommand): string | undefined {
  if (cmd.marked.some(word => word.includes(LIVE)) || cmd.writes.length > 0) return undefined
  const [name, ...args] = cmd.marked.map(unmark)
  if (name === 'echo') return echoText(args)
  if (name === 'printf') return printfText(args)
  return undefined
}

/** `cat` with no operand and `tee` with no option copy their stdin to stdout. */
function passesThrough(cmd: SimpleCommand): boolean {
  if (cmd.marked.some(word => word.includes(LIVE)) || cmd.writes.length > 0) return false
  const [name, ...args] = cmd.marked.map(unmark)
  return (name === 'cat' && args.length === 0) || (name === 'tee' && !args.some(a => a.startsWith('-')))
}

/** What `cmd` writes into the pipe after it, given what it reads. */
export function stageOutput(cmd: SimpleCommand, input: Feed): Feed {
  const text = printed(cmd)
  if (text !== undefined) return { texts: [text] }
  return passesThrough(cmd) ? input : 'unknown'
}

/**
 * The text a pipe hands `cmd`. Only a plain top-level stage right before it is read: the splitter
 * keeps no parenthesis depth, so after `( … )`, `{ … }` or a loop the pipe may carry earlier output too.
 */
export function pipeFeed(prev: SimpleCommand | undefined, prevOutput: Feed, cmd: SimpleCommand): Feed {
  if (prev === undefined || prev.after !== '|' || prev.nested || cmd.nested) return 'unknown'
  return prevOutput
}

/**
 * What `cmd` reads: its pipe and its heredoc (zsh feeds both), or else the stdin it inherits.
 * A heredoc or here-string the shell expands, a file redirect or a second source is `stdinLive`:
 * the text that reaches the reader is not the text the splitter holds, so it is 'unknown'.
 */
export function ownFeed(cmd: SimpleCommand, pipe: Feed | undefined, inherited: Feed): Feed {
  const own: Feed | undefined = cmd.stdinLive
    ? 'unknown'
    : cmd.stdin === undefined
      ? undefined
      : { texts: [cmd.stdin] }
  if (pipe !== undefined) return joinFeeds(pipe, own ?? NOTHING)
  return own ?? inherited
}

// The words a redirect on a group, subshell, loop, if or case attaches to; the splitter keeps a `)` for a subshell's.
const CLOSERS = new Set(['}', ')', 'done', 'fi', 'esac'])

/**
 * A command as the shell runs it: its marked words from the command name on, past reserved words,
 * assignments and prefix words such as `time -p`, `noglob`, `command --` and `exec -a NAME`, and
 * whether one of the words dropped was `exec`.
 */
export interface CommandHead {
  words: readonly string[]
  execs: boolean
}

/** The names the commands define as functions, by `name ()` or `function name`. */
function definedFunctions(cmds: readonly SimpleCommand[]): Set<string> {
  const names = new Set<string>()
  for (const cmd of cmds) {
    if (cmd.defines !== undefined) names.add(cmd.defines)
    cmd.words.forEach(
      (word, i) => word === 'function' && i + 1 < cmd.words.length && names.add(cmd.words[i + 1] as string),
    )
  }
  return names
}

/** What a pipe hands a function call, reading the stage before it with stdin it cannot read. */
const callPipe = (prev: SimpleCommand | undefined, cmd: SimpleCommand): Feed | undefined =>
  cmd.before === '|' && prev !== undefined ? pipeFeed(prev, stageOutput(prev, 'unknown'), cmd) : undefined

/**
 * What the line feeds commands the splitter cannot place under their reader (CC-1408): a redirect
 * on a group, subshell, loop, if or case, an `exec` redirect, and a call of a function the line
 * defines. The splitter keeps no group bounds and checks a function body where it is defined, so
 * every command on the line that reads the stdin it inherits is taken to read this too.
 */
export function indirectFeed(
  cmds: readonly SimpleCommand[],
  headOf: (cmd: SimpleCommand) => CommandHead | undefined,
): Feed {
  const functions = definedFunctions(cmds)
  return cmds.reduce<Feed>(
    (feed, cmd, i) => joinFeeds(feed, indirectSource(cmd, headOf(cmd), cmds[i - 1], functions)),
    NOTHING,
  )
}

/**
 * What one command feeds the line that way. Whatever follows an `exec`, its redirect may stay on
 * the line's stdin: with a program after it the rest of the line never runs, so counting it costs
 * nothing. An expanded command word may be `exec`, and `eval` text may hold one, so that is 'unknown'.
 */
function indirectSource(
  cmd: SimpleCommand,
  head: CommandHead | undefined,
  prev: SimpleCommand | undefined,
  functions: Set<string>,
): Feed {
  const [first, ...rest] = head?.words ?? []
  if (head?.execs === true) return ownFeed(cmd, undefined, NOTHING)
  if (first === undefined) return NOTHING
  const name = unmark(first)
  if (name === 'eval' && rest.some(word => /\bexec\b/.test(unmark(word)))) return 'unknown'
  if (first.includes(LIVE) || (CLOSERS.has(name) && rest.length === 0))
    return ownFeed(cmd, undefined, NOTHING)
  return functions.has(name) ? ownFeed(cmd, callPipe(prev, cmd), NOTHING) : NOTHING
}

export const isNothing = (feed: Feed): boolean => feed !== 'unknown' && feed.texts.length === 0

// The paths through which a reader opens its own stdin: /dev/stdin, /dev/fd/0, /proc/self/fd/0.
const STDIN_PATH = /(?:^|\/)(?:stdin|fd\/0+)$/

/** Whether a script operand may be the reader's own stdin: a stdin path, or a word the shell expands. */
export const mayReadStdin = (marked: string | undefined): boolean =>
  marked !== undefined && (marked.includes(LIVE) || STDIN_PATH.test(path.posix.normalize(unmark(marked))))
