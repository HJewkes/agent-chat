import fs from 'node:fs'
import path from 'node:path'

/**
 * Every hook git runs by name from `core.hooksPath`. Overriding the hooks path hides the repo's
 * own hooks, so each name gets a shim that chains to the repo's hook of the same name.
 */
export const HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'post-index-change',
] as const

const HOOKS_PATH_KEY = 'core.hooksPath'

/** Command-scope git config through the environment, so no repo's `.git/config` is written. */
export const gitHooksEnv = (dir: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: HOOKS_PATH_KEY,
  GIT_CONFIG_VALUE_0: dir,
})

/** The guard dir a launch env points git at, if any. */
export const hooksDirOf = (env: Record<string, string>): string | undefined =>
  env.GIT_CONFIG_COUNT === '1' && env.GIT_CONFIG_KEY_0 === HOOKS_PATH_KEY ? env.GIT_CONFIG_VALUE_0 : undefined

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// The repo's own hooks dir, read with the guard's env override removed; a relative path is relative to the hook's cwd, as git reads it.
const FIND_REPO_HOOK = `own=$(env -u GIT_CONFIG_COUNT git config --type=path core.hooksPath 2>/dev/null)
[ -n "$own" ] || own="$(git rev-parse --git-common-dir)/hooks"
guard=$(cd "$(dirname "$0")" && pwd -P)
[ "$(cd "$own" 2>/dev/null && pwd -P)" = "$guard" ] && own=
hook="$own/$(basename "$0")"
[ -n "$own" ] && [ -f "$hook" ] && [ -x "$hook" ] || hook=`

const HEADER = '#!/bin/sh\n# Written by agent-chat at each spawn (CC-268); local edits are overwritten.\n'

function chainShim(): string {
  return `${HEADER}${FIND_REPO_HOOK}\n[ -n "$hook" ] || exit 0\nexec "$hook" "$@"\n`
}

/** The scan's refusal does not skip the repo's own hook; either one failing refuses the push. */
function prePushShim(node: string, cli: string): string {
  return `${HEADER}refs=$(mktemp) || exit 1
trap 'rm -f "$refs"' EXIT
cat > "$refs"
${shellQuote(node)} ${shellQuote(cli)} leak-scan --pre-push "--remote=$1" "--url=$2" < "$refs"
scan=$?
${FIND_REPO_HOOK}
own_status=0
if [ -n "$hook" ]; then "$hook" "$@" < "$refs"; own_status=$?; fi
[ "$scan" -eq 0 ] || exit "$scan"
exit "$own_status"
`
}

export function hookScripts(node: string, cli: string): Map<string, string> {
  return new Map(HOOK_NAMES.map(name => [name, name === 'pre-push' ? prePushShim(node, cli) : chainShim()]))
}

/** Replaced by rename, so a hook git is running at that moment never reads a half-written file. */
function writeIfChanged(file: string, body: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === body && (fs.statSync(file).mode & 0o777) === 0o755) return
  } catch {
    // Absent: write it below.
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, { mode: 0o755 })
  fs.chmodSync(tmp, 0o755)
  fs.renameSync(tmp, file)
}

export function writeGitHooks(dir: string, node: string, cli: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, body] of hookScripts(node, cli)) writeIfChanged(path.join(dir, name), body)
}
