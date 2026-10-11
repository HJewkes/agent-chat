import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ghShimDir } from '../paths.js'
import { gitShimDirFor } from './git-shim.js'
import { ENVIRONMENT_SCRUB, hardenedShebang, posixShell } from './posix-shell.js'

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
const FIND_REPO_HOOK = `own=$(unset GIT_CONFIG_COUNT; git rev-parse --git-path hooks 2>/dev/null)
hook="$own/\${0##*/}"
[ -n "$own" ] && [ -f "$hook" ] && [ -x "$hook" ] || hook=
[ -n "$hook" ] && [ "$(cd "$own" && pwd -P)" = "$(cd "\${0%/*}" && pwd -P)" ] && hook=`

const WRITTEN_BY = '# Written by agent-chat at each spawn (CC-268); local edits are overwritten.\n'

const chainShim = (shell: string): string =>
  `#!${shell}\n${WRITTEN_BY}${ENVIRONMENT_SCRUB}${FIND_REPO_HOOK}\n[ -n "$hook" ] || exit 0\nexec "$hook" "$@"\n`

// -p: bash as sh imports no functions and ignores SHELLOPTS from the agent's environment; dash has no such import and rejects the flag, so hardenedShebang omits it there.
const prePushHeader = (shell: string): string => `${hardenedShebang(shell)}\n${WRITTEN_BY}`

const NOT_RUN = 'leak-scan: guard NOT run, this push was not scanned'

const INSTALL_HINT = 'Run npm i -g @titan-design/egress-scan; see docs/leak-guard.md.'

/** Flip to false to let a push through, generic rules only, while the owner has no private term list. */
export const MISSING_TERMS_REFUSES = true

// egress-scan's own stderr line; its exit code (2) is shared with every config error.
const MISSING_TERMS_LINE = 'private term list not found'

/** What the pre-push shim bakes in when it is written, so nothing the agent's environment holds is trusted. */
export interface ScanInputs {
  missingTermsRefuses: boolean
  /** The owner's home from the passwd entry; derives the term list's path. */
  home: string
  /** The broker's own PATH, absolute entries only; the hook never uses the agent's PATH. */
  path: string
  /** Checks the scanner on the PATH the hook bakes once, at write time; absent, every push checks it. */
  probe?: (bakedPath: string) => ScannerFacts | undefined
}

/** What `titan-egress-scan --help` said when the hooks were written. */
export type ScanVerdict = 'scans-text' | 'skips-binary' | 'no-pre-push'

export interface ScannerFacts {
  /** The realpath of the scanner the baked PATH finds, which the hook runs as `node <scanner>`. */
  scanner: string
  /** The node the scanner's env shebang finds on the baked PATH, as found, so an upgrade keeps it. */
  node: string
  verdict: ScanVerdict
  /** The scanner's mtime, unchanged across the --help run; the stamp file beside the hooks carries it. */
  mtimeMs: number
}

const SCANNER = 'titan-egress-scan'
const PROBE_TIMEOUT_MS = 5000

const executableOnPath = (name: string, searchPath: string): string | undefined =>
  searchPath
    .split(':')
    .map(dir => path.join(dir, name))
    .find(file => {
      try {
        fs.accessSync(file, fs.constants.X_OK)
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })

const verdictOf = (help: string): ScanVerdict =>
  !help.includes('pre-push')
    ? 'no-pre-push'
    : help.includes('scanned as text')
      ? 'scans-text'
      : 'skips-binary'

/**
 * `test -nt` in dash and bash 3.2 compares whole seconds, so a scanner replaced within the second
 * it was probed in would pass the push-time check. A scanner written this recently is not baked;
 * any later npm install then lands in a later second, and the check sees it.
 */
const SETTLED_MS = 2000

// SIGKILL, since the broker waits on this run and a scanner may ignore SIGTERM.
function helpText(node: string, scanner: string, bakedPath: string): string | undefined {
  const run = spawnSync(node, [scanner, '--help'], {
    env: { PATH: bakedPath },
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  // A timeout sets error even when the scanner exited 0 and a grandchild held its output open.
  if (run.error !== undefined || run.signal !== null || run.status !== 0) return undefined
  return `${run.stdout}${run.stderr}`
}

/**
 * Runs the scanner's --help once, the way the hook would, with an environment of PATH alone. A
 * scanner or node that is missing, a help run that fails, is killed or times out, a scanner
 * written within the last two seconds, or one whose mtime moved during the run yields nothing,
 * so the hook keeps checking at every push.
 */
export function probeScanner(bakedPath: string): ScannerFacts | undefined {
  const found = executableOnPath(SCANNER, bakedPath)
  const node = executableOnPath('node', bakedPath)
  if (found === undefined || node === undefined) return undefined
  try {
    const scanner = fs.realpathSync(found)
    const { mtimeMs } = fs.statSync(scanner)
    if (Date.now() - mtimeMs < SETTLED_MS) return undefined
    const help = helpText(node, scanner, bakedPath)
    if (help === undefined || fs.statSync(scanner).mtimeMs !== mtimeMs) return undefined
    return { scanner, node, verdict: verdictOf(help), mtimeMs }
  } catch {
    return undefined
  }
}

// os.userInfo() reads the passwd entry, not $HOME; os.homedir() is the fallback when there is none.
export function passwdHome(): string {
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

export const termsFileFor = (home: string): string =>
  path.join(home, '.config', 'titan-egress', 'private-terms')

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const missingTermsNote = (refuses: boolean, termsFile: string): string =>
  refuses
    ? `leak-scan: push refused: no private term list at ${termsFile}. Create it, one term per line, chmod 600; see docs/leak-guard.md.`
    : `leak-scan: WARNING: no private term list at ${termsFile}, so this push was scanned with generic rules only. Create it; see docs/leak-guard.md.`

const ALLOW_HINT =
  "leak-scan: only .egress-allow entries already on the remote's default branch count; see docs/leak-guard.md."

// The scanner sees the repo's objects and nothing else: no worktree, index, refs, repo config or attributes.
const OBJECT_VIEW = `view=$tmp/view
objects=$(cd "$(git rev-parse --git-path objects)" 2>/dev/null && pwd -P) &&
  clean git init -q --template= "$view" >/dev/null 2>&1 &&
  printf '%s\\n' "$objects" > "$view/.git/objects/info/alternates" || {
  echo "leak-scan: push refused: could not open the repository's objects for the scan." >&2
  exit 2
}
vgit() { clean git -C "$view" "$@"; }
allow_mode() { vgit ls-tree "$1" -- .egress-allow 2>/dev/null | awk '{ print $1 }'; }`

const SSH_COMMAND_SET =
  'leak-scan: push refused: core.sshCommand is set in the system or global git config, so the scan base cannot be read the way the push is sent; see docs/leak-guard.md.'

const LOOKUP_FAILED = 'leak-scan: push refused: the scan base lookup on $2 failed; see docs/leak-guard.md.'

const REWRITTEN_URL =
  'leak-scan: push refused: git config rewrites the push URL $2 for reads, so the scan base cannot be read from it; see docs/leak-guard.md.'

// The scanner lists its push URL with no HOME or SSH_AUTH_SOCK, so a private remote would fail it (CC-906).
// It is handed a local repository holding the tips the scrubbed lookup above already read.
// packed-refs needs no objects: they come through the alternates, and git skips a ref it cannot resolve.
const LISTING_REPO = `listing=$tmp/listing
if clean git init -q --bare --template= "$listing" >/dev/null 2>&1 &&
  printf '%s\\n' "$objects" > "$listing/objects/info/alternates" &&
  printf '%s\\n' "$heads" | awk '$1 ~ /^[0-9a-f]+$/ && length($1) >= 40 { printf "%s refs/tips/%d\\n", $1, NR }' > "$listing/packed-refs"; then
  push_url=$listing
else
  push_url=$2
fi`

// Asked of the push URL with only system and owner config, since agent config can send the read elsewhere.
const remoteTip = (home: string): string => `remote() {
  /usr/bin/env -i PATH="$PATH" HOME=${shQuote(home)} SSH_AUTH_SOCK="\${SSH_AUTH_SOCK-}" \\
    GIT_TERMINAL_PROMPT=0 GIT_DIR="$view/.git" git "$@"
}
[ "$(remote ls-remote --get-url "$2" 2>/dev/null)" = "$2" ] || {
  printf '%s\\n' "${REWRITTEN_URL}" >&2
  exit 2
}
[ -z "$(remote config --get core.sshCommand 2>/dev/null)" ] || {
  echo "${SSH_COMMAND_SET}" >&2
  exit 2
}
heads=$(remote ls-remote --upload-pack=git-upload-pack "$2" 2>/dev/null) || lookup_failed=1
tip=$(printf '%s\\n' "$heads" | awk '$2 == "HEAD" { print $1; exit }')
case $tip in *[!0-9a-f]*) tip= ;; esac
if [ -n "$tip" ] && ! vgit cat-file -e "$tip^{commit}" 2>/dev/null; then
  remote fetch -q --upload-pack=git-upload-pack --no-tags --no-write-fetch-head --no-recurse-submodules "$2" HEAD >/dev/null 2>&1
  vgit cat-file -e "$tip^{commit}" 2>/dev/null || tip=
fi
${LISTING_REPO}`

// A new ref, or one whose remote sha is not here, is scanned from the remote's default branch. A non-commit is refused.
const SCAN_REFS = `while read -r lref lsha rref rsha; do
  case $lsha in
  *[!0]*)
    [ "$(vgit cat-file -t "$lsha" 2>/dev/null)" = commit ] || {
      printf '%s\\n' "leak-scan: push refused: $rref is not a commit, and the scan reads commits only; see docs/leak-guard.md." >&2
      exit 2
    }
    case $(allow_mode "$lsha") in
    '' | 100644 | 100755) ;;
    *)
      printf '%s\\n' "leak-scan: push refused: .egress-allow in $lref is not a regular file; see docs/leak-guard.md." >&2
      exit 2 ;;
    esac
    case $rsha in
    *[!0]*) vgit cat-file -e "$rsha^{commit}" 2>/dev/null || rsha=$tip ;;
    *) rsha=$tip ;;
    esac
    [ -n "$rsha" ] || {
      [ -z "$lookup_failed" ] || { printf '%s\\n' "${LOOKUP_FAILED}" >&2; exit 2; }
      printf '%s\\n' "leak-scan: push refused: $1 names no default branch to scan $lref against; see docs/leak-guard.md." >&2
      exit 2
    } ;;
  esac
  printf '%s %s %s %s\\n' "$lref" "$lsha" "$rref" "$rsha"
done < "$refs" > "$tmp/scan-refs" || exit 2`

// An entry the pushed commits add would let an agent allow its own finding, so only the remote's copy counts.
const ALLOW_LIST = `[ -z "$tip" ] || case $(allow_mode "$tip") in
100644 | 100755) vgit cat-file blob "$tip:.egress-allow" > "$view/.egress-allow" || exit 2 ;;
esac`

/** A `scans-text` verdict and the stamp file whose mtime pins the scanner it was found for. */
export interface Bake {
  facts: ScannerFacts
  stamp: string
}

// The second argument is the push URL, so the scanner excludes the tips the remote already has (CC-906).
// The baked node runs the scanner directly, skipping its env shebang, only while the verdict holds.
const scanInvocation = (settings: string, bake: Bake | undefined): string => {
  const onPath = `clean ${settings} titan-egress-scan pre-push "$1" "$push_url"`
  if (bake === undefined) return `${onPath} < "$tmp/scan-refs" 2> "$errs"`
  const node = shQuote(bake.facts.node)
  return `if [ -n "$fresh" ] && [ -f ${node} ] && [ -x ${node} ]; then
      clean ${settings} ${node} ${shQuote(bake.facts.scanner)} pre-push "$1" "$push_url"
    else
      ${onPath}
    fi < "$tmp/scan-refs" 2> "$errs"`
}

const runScanner = (refuses: boolean, termsFile: string, bake: Bake | undefined): string =>
  `cd "$view" || exit 2
    ${scanInvocation(`TITAN_EGRESS_TERMS=${shQuote(termsFile)} TITAN_EGRESS_REQUIRE_TERMS=${refuses ? '1' : ''}`, bake)}
    scan=$?
    cat "$errs" >&2
    if grep -q '${MISSING_TERMS_LINE}' "$errs"; then
      echo ${shQuote(missingTermsNote(refuses, termsFile))} >&2
    fi
    [ "$scan" -ne 1 ] || echo ${shQuote(ALLOW_HINT)} >&2
    exit "$scan" ;;`

const BAKED_HELP = 'pre-push: binary files are scanned as text, as checked when this hook was written'

// -ef follows symlinks, so a PATH entry that now names another file fails it; a missing stamp fails it too.
const freshCheck = ({ facts, stamp }: Bake): string => {
  const scanner = shQuote(facts.scanner)
  const stampFile = shQuote(stamp)
  return `fresh=
if [ -f ${stampFile} ] && [ "$(command -v titan-egress-scan)" -ef ${scanner} ] && ! [ ${scanner} -nt ${stampFile} ]; then
  fresh=1
  help='${BAKED_HELP}'
fi
`
}

/**
 * The scan runs in a subshell. `clean` starts git and the scanner with an environment of PATH
 * alone, so no variable of the agent's reaches them. A missing node or scanner, or one whose help
 * lacks `pre-push`, warns and lets the push go. A scanner that crashes, or whose help lacks
 * `scanned as text` (it skips binary files), refuses. The scan's
 * refusal does not skip the repo's own hook; either one failing refuses.
 *
 * With a bake, the help run is skipped only while the PATH still finds the baked scanner file and
 * that file is not newer than the stamp; `[` is a shell builtin, so the check starts no process.
 */
const scanStep = ({ missingTermsRefuses: refuses, home }: ScanInputs, bake?: Bake): string => `(
clean() { /usr/bin/env -i PATH="$PATH" "$@"; }
${bake === undefined ? '' : freshCheck(bake)}if ! command -v node >/dev/null 2>&1; then
  echo "${NOT_RUN}: no node on the broker's PATH. Put node on it and restart the broker; see docs/leak-guard.md." >&2
elif ! command -v titan-egress-scan >/dev/null 2>&1; then
  echo "${NOT_RUN}: no titan-egress-scan on the broker's PATH. ${INSTALL_HINT}" >&2
elif ${bake === undefined ? '' : '[ -z "$fresh" ] && '}! help=$(clean titan-egress-scan --help 2>&1); then
  printf '%s\\n' "$help" >&2
  echo "leak-scan: titan-egress-scan failed while checking for its pre-push command, so the push is refused." >&2
  exit 2
else
  case $help in
  *pre-push*)
    case $help in
    *'scanned as text'*) ;;
    *)
      echo "leak-scan: the titan-egress-scan on the broker's PATH skips binary files, so the push is refused. ${INSTALL_HINT}" >&2
      exit 2 ;;
    esac
    ${OBJECT_VIEW}
    ${remoteTip(home)}
    ${SCAN_REFS}
    ${ALLOW_LIST}
    ${runScanner(refuses, termsFileFor(home), bake)}
  *)
    echo "${NOT_RUN}: the titan-egress-scan on the broker's PATH has no pre-push command. ${INSTALL_HINT}" >&2 ;;
  esac
fi
)`

// Symlinks and `..` resolved, so an alias of a shim dir is still recognised; a dir that is gone keeps its lexical form.
const canonical = (dir: string): string => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

const isWithin = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}${path.sep}`)

/** The broker PATH less every entry at or under a shim dir; exact paths, so a lookalike name stays. */
function withoutShimDirs(brokerPath: string, shimDirs: readonly string[]): string {
  const roots = shimDirs.map(canonical)
  return brokerPath
    .split(':')
    .filter(dir => dir !== '' && !roots.some(root => isWithin(canonical(dir), root)))
    .join(':')
}

// An empty PATH makes sh search the current directory, the repo being pushed, so it refuses instead.
const bakePath = (brokerPath: string): string =>
  brokerPath === ''
    ? `echo "leak-scan: push refused: the broker PATH holds no directory but the agent shims; see docs/leak-guard.md." >&2
exit 2`
    : `PATH=${shQuote(brokerPath)}; export PATH`

// The broker's PATH covers the whole shim, not only the scan; the repo hook gets the agent's PATH back.
const prePushShim = (
  inputs: ScanInputs,
  shell: string,
  shimDirs: readonly string[],
  bake: Bake | undefined,
): string => `${prePushHeader(shell)}${ENVIRONMENT_SCRUB}agent_path=$PATH
${bakePath(withoutShimDirs(inputs.path, shimDirs))}
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
refs=$tmp/refs
errs=$tmp/errs
cat > "$refs"
${scanStep(inputs, bake)}
scan=$?
${FIND_REPO_HOOK}
own_status=0
if [ -n "$hook" ]; then PATH=$agent_path "$hook" "$@" < "$refs"; own_status=$?; fi
[ "$scan" -eq 0 ] || exit "$scan"
exit "$own_status"
`

/**
 * The hook never pushes, so its git calls skip the agent's git and gh shims, which the broker's
 * PATH inherits when an agent session autostarts it: every exec costs kernel memory (CC-795).
 */
export function hookScripts(
  inputs: ScanInputs = defaultScanInputs(),
  shell = posixShell(),
  shimDirs: readonly string[] = [ghShimDir()],
  bake?: Bake,
): Map<string, string> {
  return new Map([
    [
      'pre-push',
      prePushShim(inputs, shell, shimDirs, bake?.facts.verdict === 'scans-text' ? bake : undefined),
    ],
    ...CHAINED_HOOKS.map(name => [name, chainShim(shell)] as const),
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

export function writeGitHooks(
  dir: string,
  inputs: ScanInputs = defaultScanInputs(),
  shell = posixShell(),
): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const shimDirs = [gitShimDirFor(dir), ghShimDir()]
  const bake = bakeScanner(inputs, shimDirs, path.join(dir, STAMP_FILE))
  for (const [name, body] of hookScripts(inputs, shell, shimDirs, bake))
    writeIfChanged(path.join(dir, name), body)
}

/** Not a hook name, so git never runs it; only its mtime is read. */
export const STAMP_FILE = 'egress-scan.stamp'

/**
 * The stamp is written before the hook that reads it, and removed before a hook without a bake
 * lands, so a hook mid-run never pairs a verdict with a stamp from a scanner it was not found for.
 */
function bakeScanner(inputs: ScanInputs, shimDirs: readonly string[], stamp: string): Bake | undefined {
  const facts = inputs.probe?.(withoutShimDirs(inputs.path, shimDirs))
  if (facts?.verdict !== 'scans-text') {
    fs.rmSync(stamp, { force: true })
    return undefined
  }
  writeStamp(stamp, facts.mtimeMs)
  return { facts, stamp }
}

// utimes takes float seconds, which drops nanoseconds; one ms above the mtime keeps the probed file not newer.
// Shells that compare whole seconds miss a replacement whose mtime is not after the end of the probed second.
function writeStamp(stamp: string, mtimeMs: number): void {
  const tmp = `${stamp}.${process.pid}.tmp`
  const seconds = (Math.ceil(mtimeMs) + 1) / 1000
  fs.writeFileSync(tmp, '', { mode: 0o600 })
  fs.utimesSync(tmp, seconds, seconds)
  fs.renameSync(tmp, stamp)
}
