import fs from 'node:fs'
import path from 'node:path'
import { matchRules, parseTerms, type TermRule } from '@titan-design/egress-scan'
import { hooksDirOf, MISSING_TERMS_REFUSES } from './hooks-dir.js'
import { parseShell, type SimpleCommand } from './shell-words.js'

/**
 * The PreToolUse bypass guard every spawned agent runs (CC-270). It denies the ordinary ways
 * to skip the pre-push leak scan, and PR or issue text with a finding before it is posted.
 * A command-string check is a speed bump, not a boundary: docs/leak-guard.md lists the gaps.
 * Every deny reason is a fixed phrase plus locations and rule ids, never the matched text.
 */

export type TermsLoad = { kind: 'ok'; rules: TermRule[] } | { kind: 'missing' } | { kind: 'unreadable' }

export interface GuardContext {
  terms: TermsLoad
  cwd: string
  home: string
  /** Absolute paths and path fragments an agent may not touch: the hook dir and the term list. */
  protectedPaths: readonly string[]
  readFile(file: string): string | undefined
}

const DOCS = 'See docs/leak-guard.md.'

export const REASONS = {
  noVerify: `leak-guard: git push --no-verify skips the pre-push leak scan. Push without it. ${DOCS}`,
  gitConfig: `leak-guard: git -c or --config-env on core.hooksPath or an alias would bypass the pre-push leak scan. ${DOCS}`,
  configWrite: `leak-guard: writing core.hooksPath, or an alias that skips hooks, is not allowed for agents. ${DOCS}`,
  gitConfigEnv: `leak-guard: setting, exporting or unsetting GIT_CONFIG_* would switch off the pre-push leak scan. ${DOCS}`,
  envClear: `leak-guard: env -i clears the variables that run the pre-push leak scan. ${DOCS}`,
  protectedPath: `leak-guard: the leak guard's hook directory and private term list are off limits to agents. ${DOCS}`,
  tooDeep: `leak-guard: the command nests shells too deeply to check. Run it more directly. ${DOCS}`,
  stdinBody: `leak-guard: a PR or issue body read from a pipe cannot be checked. Write it to a file and pass --body-file. ${DOCS}`,
  unreadableBody: `leak-guard: a body file named in this command could not be read, so it was not checked. ${DOCS}`,
  missingTerms: `leak-guard: no private term list, so PR and issue text cannot be checked. Create ~/.config/titan-egress/private-terms, one term per line, chmod 600. ${DOCS}`,
  unreadableTerms: `leak-guard: the private term list could not be read, so PR and issue text cannot be checked. ${DOCS}`,
} as const

const MAX_DEPTH = 6

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ENV_EDITS = new Set(['export', 'unset', 'declare', 'typeset', 'readonly', 'local'])
const PREFIX_WORDS = new Set(['!', '{', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time'])
const PLAIN_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup'])
const GIT_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix'])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/
const isGitConfigVar = (name: string | undefined): boolean => name !== undefined && /^GIT_CONFIG/.test(name)
const NO_VERIFY = /^--no-veri(?:f|fy)?$/

type Unwrapped = { words: string[] } | { reason: string }

/** Strips assignments and wrappers such as `env`, `command` and `nice` down to the command that runs. */
function unwrap(words: readonly string[]): Unwrapped {
  let rest = [...words]
  for (;;) {
    const head = rest[0]
    if (head === undefined) return { words: rest }
    const assigned = ASSIGNMENT.exec(head)?.[1]
    if (assigned !== undefined) {
      if (isGitConfigVar(assigned)) return { reason: REASONS.gitConfigEnv }
      rest = rest.slice(1)
    } else if (PREFIX_WORDS.has(head) || PLAIN_WRAPPERS.has(head)) rest = dropOptions(rest.slice(1))
    else if (head === 'nice') rest = dropOptions(rest.slice(1), ['-n'])
    else if (head === 'timeout') rest = dropOptions(rest.slice(1), ['-s', '-k']).slice(1)
    else if (path.basename(head) === 'env') {
      const env = unwrapEnv(rest.slice(1))
      if ('reason' in env) return env
      rest = env.words
    } else return { words: rest }
  }
}

function dropOptions(words: string[], withValue: readonly string[] = []): string[] {
  let i = 0
  while (i < words.length && (words[i] as string).startsWith('-') && words[i] !== '-') {
    i += withValue.includes(words[i] as string) ? 2 : 1
  }
  return words.slice(i)
}

function unwrapEnv(args: string[]): Unwrapped {
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i] as string
    const unset =
      a === '-u' || a === '--unset' ? args[++i] : (/^-u(.+)/.exec(a)?.[1] ?? /^--unset=(.*)/.exec(a)?.[1])
    if (isGitConfigVar(unset)) return { reason: REASONS.gitConfigEnv }
    if (unset !== undefined) continue
    if (a === '-' || a === '--ignore-environment' || /^-[^-]*i/.test(a)) return { reason: REASONS.envClear }
    if (a === '-S' || a === '--split-string')
      return { words: [...(parseShell(args[i + 1] ?? '')[0]?.words ?? []), ...args.slice(i + 2)] }
    if (a === '-C' || a === '--chdir' || a === '-P') i++
    else if (a === '--') return { words: args.slice(i + 1) }
    else if (!a.startsWith('-') && !ASSIGNMENT.test(a)) break
    else if (isGitConfigVar(ASSIGNMENT.exec(a)?.[1])) return { reason: REASONS.gitConfigEnv }
  }
  return { words: args.slice(i) }
}

function checkEnvEdit(args: readonly string[]): string | undefined {
  const names = args.filter(a => !a.startsWith('-')).map(a => ASSIGNMENT.exec(a)?.[1] ?? a)
  return names.some(isGitConfigVar) ? REASONS.gitConfigEnv : undefined
}

function overridesGuard(kv: string | undefined): boolean {
  const key = (kv ?? '').split('=')[0]?.toLowerCase() ?? ''
  return key === 'core.hookspath' || key.startsWith('alias.')
}

function configValue(args: readonly string[], i: number): { kv: string | undefined; next: number } {
  const a = args[i] as string
  if (a === '-c' || a === '--config-env') return { kv: args[i + 1], next: i + 2 }
  if (a.startsWith('--config-env=')) return { kv: a.slice('--config-env='.length), next: i + 1 }
  if (a.startsWith('-c')) return { kv: a.slice(2), next: i + 1 }
  return { kv: undefined, next: i + (GIT_VALUE_OPTS.has(a) ? 2 : 1) }
}

export function checkGit(args: readonly string[]): string | undefined {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const { kv, next } = configValue(args, i)
    if (overridesGuard(kv)) return REASONS.gitConfig
    i = next
  }
  const [sub, ...rest] = args.slice(i)
  const opts = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
  if (sub === 'push') return opts.some(a => NO_VERIFY.test(a)) ? REASONS.noVerify : undefined
  if (sub === 'config') return configWritesGuard(rest)
  return undefined
}

function configWritesGuard(args: readonly string[]): string | undefined {
  const lower = args.map(a => a.toLowerCase())
  if (lower.some(a => a.includes('--no-veri'))) return REASONS.configWrite
  const key = lower.indexOf('core.hookspath')
  if (key < 0) return undefined
  const unsets = lower.some(a => a === 'unset' || a.startsWith('--unset'))
  return unsets || key < args.length - 1 ? REASONS.configWrite : undefined
}

interface Text {
  label: string
  text: string
}

type Texts = { texts: Text[] } | { reason: string }

const GH_TEXT_COMMANDS = new Set(['create', 'edit', 'comment', 'review'])

/** Every value of a flag, in `--flag v`, `--flag=v`, `-f v` and `-fv` spellings. */
export function flagValues(args: readonly string[], names: readonly string[]): string[] {
  const values: string[] = []
  args.forEach((a, i) => {
    for (const name of names) {
      if (a === name && i + 1 < args.length) values.push(args[i + 1] as string)
      else if (name.startsWith('--') && a.startsWith(`${name}=`)) values.push(a.slice(name.length + 1))
      else if (!name.startsWith('--') && a.startsWith(name) && a.length > name.length)
        values.push(a.slice(name.length))
    }
  })
  return values
}

function readBody(file: string, stdin: string | undefined, ctx: GuardContext): string | { reason: string } {
  if (file === '-') return stdin ?? { reason: REASONS.stdinBody }
  return ctx.readFile(path.resolve(ctx.cwd, file)) ?? { reason: REASONS.unreadableBody }
}

function collect(
  inline: Text[],
  files: { label: string; file: string }[],
  stdin: string | undefined,
  ctx: GuardContext,
): Texts {
  const texts = [...inline]
  for (const { label, file } of files) {
    const body = readBody(file, stdin, ctx)
    if (typeof body !== 'string') return body
    texts.push({ label, text: body })
  }
  return { texts }
}

function prTexts(args: readonly string[], stdin: string | undefined, ctx: GuardContext): Texts {
  const inline = [
    ...flagValues(args, ['--title', '-t']).map(text => ({ label: 'title', text })),
    ...flagValues(args, ['--body', '-b']).map(text => ({ label: 'body', text })),
  ]
  const files = flagValues(args, ['--body-file', '-F']).map(file => ({ label: 'body', file }))
  return collect(inline, files, stdin, ctx)
}

function apiTexts(args: readonly string[], stdin: string | undefined, ctx: GuardContext): Texts {
  const value = (f: string): string => f.slice(f.indexOf('=') + 1)
  const raw = flagValues(args, ['-f', '--raw-field']).map(value)
  const typed = flagValues(args, ['-F', '--field']).map(value)
  const inline = [...raw, ...typed.filter(v => !v.startsWith('@'))].map(text => ({ label: 'field', text }))
  const files = [
    ...typed.filter(v => v.startsWith('@')).map(v => ({ label: 'field', file: v.slice(1) })),
    ...flagValues(args, ['--input']).map(file => ({ label: 'input', file })),
  ]
  return collect(inline, files, stdin, ctx)
}

function ghTexts(args: readonly string[], stdin: string | undefined, ctx: GuardContext): Texts {
  const [group, verb] = args
  if ((group === 'pr' || group === 'issue') && GH_TEXT_COMMANDS.has(verb ?? ''))
    return prTexts(args, stdin, ctx)
  if (group === 'api') return apiTexts(args, stdin, ctx)
  return { texts: [] }
}

/** `label line n rule[ #term]` for each hit; the line's text never appears. */
export function findingsIn(texts: readonly Text[], rules: readonly TermRule[]): string[] {
  return texts.flatMap(({ label, text }) =>
    text
      .split('\n')
      .flatMap((line, i) =>
        matchRules(line, rules).map(
          hit =>
            `${label} line ${i + 1} ${hit.rule}${hit.termIndex === undefined ? '' : ` #${hit.termIndex}`}`,
        ),
      ),
  )
}

function checkGh(args: readonly string[], stdin: string | undefined, ctx: GuardContext): string | undefined {
  const collected = ghTexts(args, stdin, ctx)
  if ('reason' in collected) return collected.reason
  if (collected.texts.length === 0) return undefined
  if (ctx.terms.kind === 'unreadable') return REASONS.unreadableTerms
  if (ctx.terms.kind === 'missing' && MISSING_TERMS_REFUSES) return REASONS.missingTerms
  const found = findingsIn(collected.texts, ctx.terms.kind === 'ok' ? ctx.terms.rules : [])
  if (found.length === 0) return undefined
  return `leak-guard: this text would publish private data (${found.join('; ')}). Remove the flagged text and retry; the guard never prints what matched. ${DOCS}`
}

function checkShell(
  args: readonly string[],
  stdin: string | undefined,
  ctx: GuardContext,
  depth: number,
): string | undefined {
  const flag = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a))
  if (flag >= 0) return checkAt(args[flag + 1] ?? '', ctx, depth + 1)
  const script = args.find(a => !a.startsWith('-'))
  return script === undefined && stdin !== undefined ? checkAt(stdin, ctx, depth + 1) : undefined
}

const ghWriteArgs = (args: readonly string[]): readonly string[] =>
  args.includes('--') ? args.slice(args.indexOf('--') + 1) : args.slice(1)

function checkSimple(cmd: SimpleCommand, ctx: GuardContext, depth: number): string | undefined {
  const unwrapped = unwrap(cmd.words)
  if ('reason' in unwrapped) return unwrapped.reason
  const [head = '', ...args] = unwrapped.words
  const name = path.basename(head)
  if (SHELLS.has(name)) return checkShell(args, cmd.stdin, ctx, depth)
  if (name === 'eval') return checkAt(args.join(' '), ctx, depth + 1)
  if (name === 'git') return checkGit(args)
  if (name === 'gh') return checkGh(args, cmd.stdin, ctx)
  if (name === 'agent-chat' && args[0] === 'gh-write') return checkGh(ghWriteArgs(args), cmd.stdin, ctx)
  if (ENV_EDITS.has(name)) return checkEnvEdit(args)
  return undefined
}

/** Follows `cd` so a relative body file resolves the way the shell would resolve it. */
function followCd(cmd: SimpleCommand, ctx: GuardContext): GuardContext {
  const [head, dir] = cmd.words
  if (head !== 'cd' || dir === undefined || dir === '-') return ctx
  const target = dir === '~' || dir.startsWith('~/') ? ctx.home + dir.slice(1) : dir
  return { ...ctx, cwd: path.resolve(ctx.cwd, target) }
}

function checkAt(command: string, ctx: GuardContext, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return REASONS.tooDeep
  if (ctx.protectedPaths.some(p => command.includes(p))) return REASONS.protectedPath
  let at = ctx
  for (const cmd of parseShell(command)) {
    const reason = checkSimple(cmd, at, depth)
    if (reason !== undefined) return reason
    at = followCd(cmd, at)
  }
  return undefined
}

export const checkCommand = (command: string, ctx: GuardContext): string | undefined =>
  checkAt(command, ctx, 0)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The deny reason for one tool call, or undefined to leave it to the normal permission flow. */
export function checkToolCall(toolName: string, toolInput: unknown, ctx: GuardContext): string | undefined {
  const input = (toolInput ?? {}) as Record<string, unknown>
  if (toolName === 'Bash')
    return typeof input.command === 'string' ? checkCommand(input.command, ctx) : undefined
  if (!EDIT_TOOLS.has(toolName)) return undefined
  const file = input.file_path ?? input.notebook_path
  if (typeof file !== 'string') return undefined
  const resolved = path.resolve(ctx.cwd, file)
  return ctx.protectedPaths.some(p => resolved.includes(p)) ? REASONS.protectedPath : undefined
}

export const termsFile = (env: NodeJS.ProcessEnv, home: string): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'titan-egress', 'private-terms')

/** Read from the default path only, never `TITAN_EGRESS_TERMS`, so an inherited value cannot empty the list. */
export function loadTerms(file: string): TermsLoad {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'ok', rules: parseTerms(text) }
  } catch {
    return { kind: 'unreadable' }
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function guardContext(env: NodeJS.ProcessEnv, cwd: string, home: string): GuardContext {
  const terms = termsFile(env, home)
  const hooksDir = hooksDirOf(env as Record<string, string>)
  return {
    terms: loadTerms(terms),
    cwd,
    home,
    protectedPaths: [
      terms,
      'titan-egress/private-terms',
      '.agent-chat/git-hooks',
      ...(hooksDir === undefined ? [] : [hooksDir]),
    ],
    readFile: readText,
  }
}

/** Claude Code's PreToolUse deny shape. */
export const denyOutput = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })

const MENTIONS_GIT = /\b(?:git|gh)\b|GIT_CONFIG/

/**
 * The hook's stdout for Claude Code's stdin, or '' to allow. A call the guard cannot read is
 * denied only when it mentions git or gh, so a guard bug cannot block every other command.
 */
export function pretoolDecision(raw: string, build: (cwd: string) => GuardContext): string {
  try {
    const input = JSON.parse(raw) as { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
    if (typeof input.tool_name !== 'string') throw new Error('no tool_name')
    const ctx = build(typeof input.cwd === 'string' ? input.cwd : process.cwd())
    const reason = checkToolCall(input.tool_name, input.tool_input, ctx)
    return reason === undefined ? '' : denyOutput(reason)
  } catch {
    return MENTIONS_GIT.test(raw)
      ? denyOutput('leak-guard: the guard could not check this call. ' + DOCS)
      : ''
  }
}
