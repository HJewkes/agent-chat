import fs from 'node:fs'
import path from 'node:path'

/**
 * Client hooks shimmed to chain to the repo's own hook, since overriding the hooks path hides it.
 * Each shim costs a shell and a git call, so the hooks that fire on every commit without gating it
 * (`reference-transaction`, `post-index-change`, `prepare-commit-msg`, `post-commit`) are not
 * chained and do not run for agents. Server-side names never run in an agent's repo.
 */
export const CHAINED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'commit-msg',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'pre-auto-gc',
  'sendemail-validate',
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

// One git call: `--git-path hooks` honours the repo's own core.hooksPath once the guard's override is removed.
const FIND_REPO_HOOK = `own=$(env -u GIT_CONFIG_COUNT git rev-parse --git-path hooks 2>/dev/null)
hook="$own/\${0##*/}"
[ -n "$own" ] && [ -f "$hook" ] && [ -x "$hook" ] || hook=
[ -n "$hook" ] && [ "$(cd "$own" && pwd -P)" = "$(cd "\${0%/*}" && pwd -P)" ] && hook=`

const HEADER = '#!/bin/sh\n# Written by agent-chat at each spawn (CC-268); local edits are overwritten.\n'

const CHAIN_SHIM = `${HEADER}${FIND_REPO_HOOK}\n[ -n "$hook" ] || exit 0\nexec "$hook" "$@"\n`

const NOT_RUN = 'leak-scan: guard NOT run, this push was not scanned'

/**
 * node and agent-chat are found on PATH when the hook runs, never baked in: a versioned node or a
 * worktree's dist goes away and would refuse every push. A missing one, or an installed CLI whose
 * help works but lacks `--pre-push`, warns and lets the push go. A CLI that crashes still refuses.
 * The scan's refusal does not skip the repo's own hook; either one failing refuses the push.
 */
const PRE_PUSH_SHIM = `${HEADER}refs=$(mktemp) || exit 1
trap 'rm -f "$refs"' EXIT
cat > "$refs"
scan=0
if ! command -v node >/dev/null 2>&1; then
  echo "${NOT_RUN}: no node on PATH. Put node on the agent's PATH; see docs/leak-guard.md." >&2
elif ! command -v agent-chat >/dev/null 2>&1; then
  echo "${NOT_RUN}: no agent-chat on PATH. Run npm link in the agent-chat checkout; see docs/leak-guard.md." >&2
elif ! help=$(agent-chat leak-scan --help 2>&1); then
  printf '%s\\n' "$help" >&2
  echo "leak-scan: agent-chat failed while checking for leak-scan --pre-push, so the push is refused." >&2
  scan=2
else
  case $help in
  *--pre-push*)
    agent-chat leak-scan --pre-push "--remote=$1" "--url=$2" < "$refs"
    scan=$? ;;
  *)
    echo "${NOT_RUN}: the agent-chat on PATH has no leak-scan --pre-push. Rebuild the linked checkout (npm run build); see docs/leak-guard.md." >&2 ;;
  esac
fi
${FIND_REPO_HOOK}
own_status=0
if [ -n "$hook" ]; then "$hook" "$@" < "$refs"; own_status=$?; fi
[ "$scan" -eq 0 ] || exit "$scan"
exit "$own_status"
`

export function hookScripts(): Map<string, string> {
  return new Map([['pre-push', PRE_PUSH_SHIM], ...CHAINED_HOOKS.map(name => [name, CHAIN_SHIM] as const)])
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

export function writeGitHooks(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, body] of hookScripts()) writeIfChanged(path.join(dir, name), body)
}
