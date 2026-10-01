import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Names the dir holding the agent's `git` shim in the launch plan; `run-agent` puts it first on PATH. */
export const GIT_SHIM_DIR_ENV = 'AGENT_CHAT_GIT_SHIM_DIR'

/** `<home>/git-bin`, beside the guard's `<home>/git-hooks`, so the pure plan builder needs no extra input. */
export const gitShimDirFor = (hooksDir: string): string => path.join(path.dirname(hooksDir), 'git-bin')

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

// Global options whose value is the next word; every other leading dash word stands alone.
const VALUED_GLOBALS =
  '-C | -c | --git-dir | --work-tree | --namespace | --config-env | --attr-source | --super-prefix'

const DOCS = 'See docs/leak-guard.md.'

// Pure sh, no fork: sets q to $1 single-quoted for eval.
const QUOTE_FN = `sq="'"
quote() {
  q= rest=$1
  while :; do
    case $rest in
    *"$sq"*) q="$q\${rest%%"$sq"*}'\\\\''"; rest=\${rest#*"$sq"} ;;
    *) q="'$q$rest'"; return ;;
    esac
  done
}`

const REFUSE_FN = `refuse() {
  echo "git-shim: push refused ($1): $2 ${DOCS}" >&2
  exit 2
}`

// git's split_cmdline: quotes group, a backslash escapes outside single quotes, an open quote fails.
const SPLIT_FN = `tab='	'
nl='
'
split() {
  s=$1 words= word= started= quoted=
  while [ -n "$s" ]; do
    c=\${s%"\${s#?}"}
    s=\${s#?}
    if [ -z "$quoted" ]; then
      case $c in
      ' ' | "$tab" | "$nl")
        [ -z "$started" ] || { quote "$word"; words="$words $q"; word= started=; }
        continue ;;
      \\' | \\") quoted=$c started=1; continue ;;
      esac
    elif [ "$c" = "$quoted" ]; then
      quoted=
      continue
    fi
    if [ "$c" = \\\\ ] && [ "$quoted" != \\' ]; then
      [ -n "$s" ] || return 1
      c=\${s%"\${s#?}"}
      s=\${s#?}
    fi
    word=$word$c started=1
  done
  [ -z "$quoted" ] || return 1
  [ -z "$started" ] || { quote "$word"; words="$words $q"; }
}`

// Fails closed: a word it cannot resolve, or an alias chain past the cap, refuses rather than execs.
const RESOLVE_FN = `resolve() {
  globals= depth=0
  while [ $# -gt 0 ]; do
    case $1 in
    ${VALUED_GLOBALS})
      [ $# -ge 2 ] || return 1
      quote "$1"; globals="$globals $q"; quote "$2"; globals="$globals $q"; shift 2; continue ;;
    -*) quote "$1"; globals="$globals $q"; shift; continue ;;
    push) break ;;
    esac
    case " $builtins " in *" $1 "*) return 1 ;; esac
    alias=$(eval "\\"\\$real\\"$globals config --get \\"alias.\\$1\\"" 2>/dev/null)
    case $? in
    0) ;;
    1) return 1 ;;
    *) refuse unresolved "git could not read alias.$1, so the shim cannot tell whether this is a push." ;;
    esac
    case $alias in
    !*)
      case $(printf '%s' "$alias $*" | tr -d "\\"'\\\\\\\\") in
      *push*) refuse shell-alias "alias.$1 runs a shell command and the command mentions push; run git push directly." ;;
      esac
      return 1 ;;
    esac
    split "$alias" || refuse unresolved "alias.$1 has an open quote or a trailing backslash."
    depth=$((depth + 1))
    [ "$depth" -le 10 ] || refuse alias-depth "alias.$1 is more than 10 aliases deep."
    shift
    eval "set -- $words \\"\\$@\\""
  done
  [ $# -gt 0 ] || return 1
  shift
  for word; do
    case $word in --no-veri*) refuse no-verify "git push --no-verify skips the pre-push leak scan." ;; esac
  done
}`

const HOOKS_CHECK = `hooks=$(eval "\\"\\$real\\"$globals config --get core.hooksPath" 2>/dev/null)
[ "$hooks" = "$guard" ] ||
  refuse hooks-path "core.hooksPath is not the leak guard's hooks dir, so the pre-push leak scan would not run."`

/**
 * The agent's `git`: a push, found after global options or through `alias.<word>`, is refused when
 * it skips verification or when the hooks path git resolves is not the guard's. Everything else
 * execs the real git, baked as an absolute path so the shim never finds itself.
 */
export const gitShimScript = (real: string, guard: string, builtins: readonly string[]): string =>
  `#!/bin/sh -p
# Written by agent-chat at each spawn (TP-596); local edits are overwritten.
real=${shQuote(real)}
guard=${shQuote(guard)}
builtins=${shQuote(builtins.join(' '))}
${QUOTE_FN}
${REFUSE_FN}
${SPLIT_FN}
${RESOLVE_FN}
if resolve "$@"; then
${HOOKS_CHECK}
fi
exec "$real" "$@"
`

const realpathOr = (file: string): string => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

const isExecutableFile = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The first `git` on PATH that is not the shim; kept unresolved so a package upgrade does not strand it. */
export function findRealGit(pathValue: string, shimDir: string): string | undefined {
  const shim = realpathOr(path.join(shimDir, 'git'))
  const ownDir = realpathOr(shimDir)
  for (const dir of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(dir) || realpathOr(dir) === ownDir) continue
    const candidate = path.join(dir, 'git')
    if (isExecutableFile(candidate) && realpathOr(candidate) !== shim) return candidate
  }
  return undefined
}

/** Empty on failure: `push` is matched by name first, so this only costs other words a config read. */
function gitBuiltins(real: string): string[] {
  try {
    return execFileSync(real, ['--list-cmds=builtins'], { encoding: 'utf8', timeout: 5000 })
      .split('\n')
      .filter(name => /^[a-z0-9-]+$/.test(name))
  } catch {
    return []
  }
}

/** Rewritten through a rename, so a git call at that moment never execs a half-written file. */
export function writeGitShim(
  dir: string,
  guard: string,
  pathValue: string = process.env.PATH ?? '',
): boolean {
  const real = findRealGit(pathValue, dir)
  if (real === undefined) return false
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, 'git')
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, gitShimScript(real, guard, gitBuiltins(real)), { mode: 0o755 })
  fs.chmodSync(temp, 0o755)
  fs.renameSync(temp, target)
  return true
}
