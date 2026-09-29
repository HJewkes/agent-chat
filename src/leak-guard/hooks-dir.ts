import fs from 'node:fs'
import os from 'node:os'
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

const INSTALL_HINT = 'Run npm i -g @titan-design/egress-scan; see docs/leak-guard.md.'

/** Flip to false to let a push through, generic rules only, while the owner has no private term list. */
export const MISSING_TERMS_REFUSES = true

// egress-scan's own stderr line; its exit code (2) is shared with every config error.
const MISSING_TERMS_LINE = 'private term list not found'

/** What the pre-push shim bakes in when it is written, so nothing the agent's environment holds is trusted. */
export interface ScanInputs {
  missingTermsRefuses: boolean
  /** The owner's home from the passwd entry; derives the term list's path and the scanner's HOME. */
  home: string
  /** The broker's own PATH, absolute entries only; the scan never sees the agent's PATH. */
  path: string
}

// os.userInfo() reads the passwd entry, not $HOME; os.homedir() is the fallback when there is none.
function passwdHome(): string {
  try {
    return os.userInfo().homedir
  } catch {
    return os.homedir()
  }
}

const absolutePath = (value: string | undefined): string =>
  (value ?? '')
    .split(':')
    .filter(dir => path.isAbsolute(dir))
    .join(':')

export const defaultScanInputs = (): ScanInputs => ({
  missingTermsRefuses: MISSING_TERMS_REFUSES,
  home: passwdHome(),
  path: absolutePath(process.env.PATH),
})

export const termsFileFor = (home: string): string => path.join(home, '.config', 'titan-egress', 'private-terms')

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const missingTermsNote = (refuses: boolean, termsFile: string): string =>
  refuses
    ? `leak-scan: push refused: no private term list at ${termsFile}. Create it, one term per line, chmod 600; see docs/leak-guard.md.`
    : `leak-scan: WARNING: no private term list at ${termsFile}, so this push was scanned with generic rules only. Create it; see docs/leak-guard.md.`

// egress-scan honours an uncommitted .egress-allow in the worktree, so an agent could write one to silence it.
const ALLOW_CHECK = `top=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$top" ] && { [ -e "$top/.egress-allow" ] || [ -L "$top/.egress-allow" ]; }; then
  git -C "$top" ls-files --error-unmatch -- .egress-allow >/dev/null 2>&1 && git -C "$top" diff --quiet HEAD -- .egress-allow || {
    echo "leak-scan: push refused: .egress-allow differs from the committed copy, and only a committed one may allow findings. Commit it or remove it; see docs/leak-guard.md." >&2
    exit 2
  }
fi`

/**
 * The scan runs in a subshell under the broker's PATH and the passwd home, both baked in at spawn,
 * with node's code-loading variables cleared, so the agent's environment cannot swap or silence the
 * scanner. A missing node or scanner, or one whose help lacks `pre-push`, warns and lets the push
 * go. A scanner that crashes still refuses. `CI=` stops egress-scan skipping the term list. The
 * scan's refusal does not skip the repo's own hook; either one failing refuses.
 */
const scanStep = ({ missingTermsRefuses: refuses, home, path: scanPath }: ScanInputs): string => {
  const termsFile = termsFileFor(home)
  return `(
PATH=${shQuote(scanPath)}; export PATH
HOME=${shQuote(home)}; export HOME
unset NODE_OPTIONS NODE_PATH XDG_CONFIG_HOME LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
${ALLOW_CHECK}
if ! command -v node >/dev/null 2>&1; then
  echo "${NOT_RUN}: no node on the broker's PATH. Put node on it and restart the broker; see docs/leak-guard.md." >&2
elif ! command -v titan-egress-scan >/dev/null 2>&1; then
  echo "${NOT_RUN}: no titan-egress-scan on the broker's PATH. ${INSTALL_HINT}" >&2
elif ! help=$(titan-egress-scan --help 2>&1); then
  printf '%s\\n' "$help" >&2
  echo "leak-scan: titan-egress-scan failed while checking for its pre-push command, so the push is refused." >&2
  exit 2
else
  case $help in
  *pre-push*)
    CI= TITAN_EGRESS_TERMS=${shQuote(termsFile)} TITAN_EGRESS_REQUIRE_TERMS=${refuses ? '1' : ''} titan-egress-scan pre-push "$1" < "$refs" 2> "$errs"
    scan=$?
    cat "$errs" >&2
    if grep -q '${MISSING_TERMS_LINE}' "$errs"; then
      echo ${shQuote(missingTermsNote(refuses, termsFile))} >&2
    fi
    exit "$scan" ;;
  *)
    echo "${NOT_RUN}: the titan-egress-scan on the broker's PATH has no pre-push command. ${INSTALL_HINT}" >&2 ;;
  esac
fi
)`
}

const prePushShim = (inputs: ScanInputs): string => `${HEADER}refs=$(mktemp) || exit 1
errs=$(mktemp) || exit 1
trap 'rm -f "$refs" "$errs"' EXIT
cat > "$refs"
${scanStep(inputs)}
scan=$?
${FIND_REPO_HOOK}
own_status=0
if [ -n "$hook" ]; then "$hook" "$@" < "$refs"; own_status=$?; fi
[ "$scan" -eq 0 ] || exit "$scan"
exit "$own_status"
`

export function hookScripts(inputs: ScanInputs = defaultScanInputs()): Map<string, string> {
  return new Map([
    ['pre-push', prePushShim(inputs)],
    ...CHAINED_HOOKS.map(name => [name, CHAIN_SHIM] as const),
  ])
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

export function writeGitHooks(dir: string, inputs: ScanInputs = defaultScanInputs()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const [name, body] of hookScripts(inputs)) writeIfChanged(path.join(dir, name), body)
}
