import type { ReturnContract } from './types.js'

/**
 * CC-286: the one copy of the return contract. `<spawner>` is the only
 * placeholder the broker fills; the rest is for the agent to resolve.
 *
 * Compiled in rather than read from a file: the broker runs from a checkout that
 * agents write to, so a file read at spawn time let any of them reword the
 * contract for every later spawn. A change here needs a build and a restart.
 */

/**
 * A block is paid for on every contracted spawn, so it stays a paragraph. CC-1184 raised it from 2450
 * for `REVIEW_TREE_RULE`: concurrent reviewers each installing base, old and head trees filled /tmp.
 * CC-1384 raised it from 2600 for `GH_READS_RULE` and the filled visibility line, which replace reads
 * the profiles refused 1,700 times a week. CC-1660 raised it from 2800 for `FRICTION_LINE`.
 */
export const MAX_BLOCK_CHARS = 3000

const NEVER_PARK =
  'Never end a turn on a background task, a sleep or a ScheduleWakeup: headless, you exit at turn ' +
  'end, killing it.'

/** CC-647: a logging shim named gh resolved gh to itself and forked until swap ran out. */
const SHIM_RULE =
  'Never put a shim named gh, git, node, npm or pnpm on PATH unless it drops its own dir from PATH ' +
  'first (pattern: src/gh-shim/install.ts).'

/**
 * CC-501 S3: the forms the leak guard allows. CC-897: a heredoc on stdin is scanned by the guard as it
 * stands and by gh-write again, so a body is posted in one call; writing a .md file and posting it on
 * the same line is the guard's writtenBody denial. pr-ready still reads a file: a fixed shared
 * `$TMPDIR` name let one agent post another's body (CC-725). The bd-implementer profiles carry both too.
 */
export const BODY_FILE_RULE =
  "Post a body or comment in one call: `agent-chat gh-write -- <gh args> --body-file - <<'EOF'`, text, " +
  "EOF, no file. pr-ready's <f>: a .md Write put in your own worktree, deleted after."

/** A reviewer has no Write and works in the implementer's tree, so it writes no file there. */
export const REVIEWER_BODY_FILE_RULE =
  "If you post text, use one call: `agent-chat gh-write -- <gh args> --body-file - <<'EOF'`, text, " +
  'EOF; write no file, the tree is not yours.'

/** CC-690: the mechanical blockers (dirty tree, stale base, red checks, leak terms) cost a reviewer round each. */
export const PR_READY_RULE =
  'Before the first push, never after, run `agent-chat pr-ready --title <t> --body-file <f>`; fix every FAIL.'

export const QUOTE_RULE =
  'Quote expansions in git and gh args (`git -C "$dir"`); never hold a command name in a variable.'

/**
 * CC-311: Claude Code cannot resolve a write target that holds a variable, so it asks, and a headless
 * reviewer parks on that prompt until the hook's deadline. The same edit on a literal path ran unprompted.
 */
export const MUTANT_RULE =
  "Mutants: in your own tree under `$TMPDIR/<your name>`, `sed -i.bak '<edit>' <literal path>`, then " +
  '`git checkout -- <literal path>`. Never put `$VAR`, a glob on a variable or `$(...)` in a write ' +
  'target: it raises a permission prompt nobody answers.'

/**
 * CC-713: a reviewer piped a bypass probe to bash from a shared main checkout, and it ran a real
 * `git push origin HEAD:main`. The burndown reviewer brief and the bd-reviewer prelude carry it too.
 */
export const PROBE_SANDBOX_RULE =
  'Run a probe that may use git, network or destructive commands only in a scratch repo under ' +
  '$TMPDIR/<your name> whose origin is a local bare repo (git init --bare); never in a real ' +
  'checkout, never against a real remote, never piped to a shell from a real checkout.'

/**
 * CC-452: a brief line reading exactly this keeps the implementer off Shepherd for a seat's own merge path.
 * CC-1278: it also gives the reviewer the variant that reads CI itself and may say WAIT.
 */
export const SHEPHERD_NONE_MARKER = 'Shepherd: none'

/**
 * CC-1384: the broker fills this with the repo's visibility, read at spawn. The bd-* profiles deny
 * `gh api` and `gh repo`, so an instruction to read it cost 1,060 refusals in a week.
 */
export const VISIBILITY_PLACEHOLDER = '<repo visibility>'

/** CC-1384: the reads the profiles allow, for the `gh api` shapes they refused 823 times in a week. */
export const GH_READS_RULE =
  'Read a PR with `gh pr view <n> --repo <owner>/<repo> --json reviews,comments,headRefOid,state`, a ' +
  'failed job with `gh run view <run> --repo <owner>/<repo> --job <id> --log-failed`; never gh api.'

/** CC-1660: optional, one line; the daily friction digest reads `^Friction: (.+)$`, at most 200 characters. */
export const FRICTION_LINE =
  'Optional last line: `Friction: <one line: the biggest thing that slowed you (waits, denials, flaky tests, ' +
  'missing context), or none>`.'

const IMPLEMENTER_HEAD = [
  `${VISIBILITY_PLACEHOLDER} If public, no real data in code, fixtures,`,
  'PR text, comments: task lists, charter or seat files, /Users paths, emails, private-repo IDs/text.',
  'Stop if `git log origin/<default> --grep <ID>` shows it landed.',
  'Branch from origin/<default>; check `git log origin/<default>..`.',
  'Commit before mutating; never `git checkout` uncommitted work.',
  'Scratch: worktree or `$TMPDIR/<your name>`.',
  PR_READY_RULE,
  BODY_FILE_RULE,
  'gh-write is the only write path; verify each. None: BLOCKED.',
  QUOTE_RULE,
  GH_READS_RULE,
  '403 rate limit, quota left: retry once in 5 minutes.',
]

const SHEPHERD_HANDOFF = [
  'Never --no-verify. Verify, push, open the PR over REST, never wait on CI.',
  'Only if the brief asks (one saying not to wins), run `titan-factory shepherd register <owner>/<repo>#<n>',
  '--task <initiative>/<ID> --implementer <your name> --kind <correctness|security|feature|refactor>`',
  'and report `Shepherd: <run id>`, `Shepherd: refused <first stderr line>` on exit 65, or `Shepherd: down`',
  'on exit 69 (do not wait for it). <spawner> watches CI.',
]

const OWN_CI_WAIT = [
  'Never use --no-verify. Verify locally, push and open the PR over REST.',
  'Do not run `titan-factory shepherd register`. Wait for CI as the brief directs and report each',
  "check-run's conclusion at the final head.",
]

const IMPLEMENTER_RULES = [
  NEVER_PARK,
  SHIM_RULE,
  'Load test only if the brief asks: kill only burner PIDs you recorded, not by name; `pgrep` shows none left.',
  'A PR narrowing a timeout reports per-case CI times.',
  'Not done at "PR opened": your LAST action must be chat_send to <spawner> starting with',
  '`Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`, `PR: <owner>/<repo>#<n>` and',
  '`Head: <full sha>` lines, then',
  'CI: <paste of: gh pr checks <n> --repo <owner>/<repo>>,',
]

/** CC-1591: 15 uncapped reports cost a coordinator ~12k tokens, mostly a copy of each PR body. */
const ciTail = (ciAt: string): string[] => [
  `${ciAt}, never "green" alone. \`gh run watch\` covers only one`,
  'workflow; a skipped check (std / compat) is no failure, and "required" means the required contexts on',
  'the default branch. Then `Concerns:` (what <spawner> must act on, or none; DONE_WITH_CONCERNS needs',
  'one) and `Notes:`, each at most 3 one-line items. Keep the report to ~10 lines; detail goes in the',
  'PR body or the task note.',
  FRICTION_LINE,
]

const implementerBlock = (handoff: string[], ciAt: string): string =>
  [...IMPLEMENTER_HEAD, ...handoff, ...IMPLEMENTER_RULES, ...ciTail(ciAt)].join('\n')

const IMPLEMENTER = implementerBlock(SHEPHERD_HANDOFF, 'as it stands at the push (you do not wait for CI)')

/** The implementer block for a brief carrying `SHEPHERD_NONE_MARKER`. */
export const IMPLEMENTER_WITHOUT_SHEPHERD = implementerBlock(
  OWN_CI_WAIT,
  'as it stands at the final head after the wait',
)

/** TP-2498: non-blocking work goes here and Shepherd files it as tasks, so nits stop costing a round. */
export const FOLLOW_UPS_RULE =
  'Optional, after blocking items: `Follow-ups:` then `- <title> | <done_when> | low|medium|high` per ' +
  'task; never blocks MERGE.'

/** CC-1184: three installed trees per review exhausted /tmp inodes on Linux; one install is enough. */
export const REVIEW_TREE_RULE =
  'One installed checkout per review, under `$TMPDIR/<your name>`: read base/old code via ' +
  '`git show <rev>:<path>`, `git diff` or `git worktree add --detach <dir> <rev>` without installing; ' +
  'never `git stash` (refs/stash is shared). Remove trees at verdict.'

/** CC-1278: Shepherd owns CI on a registered PR, so a WAIT on pending checks only cost a resume round. */
const SHEPHERD_CI_RULE = [
  "CI is Shepherd's: judge the code; pending or unread checks are no verdict input, never WAIT.",
  'FIX_FIRST (Class: ci-red) only if a required check-run already failed at the head.',
]

const OWN_CI_CHECK = [
  'Before MERGE, confirm every required check-run (one branch protection names) at the reviewed head',
  'with `gh pr checks <n> --repo <owner>/<repo> --required`; FIX_FIRST if a required',
  'one failed. A skipped check (std / compat) is not a failure. WAIT only for a clean review whose',
  'required checks have not finished.',
]

const reviewerBlock = (verdicts: string, ciRule: string[]): string =>
  [
    `Plain-text stdout is invisible to <spawner>. ${NEVER_PARK}`,
    'Your LAST action must be chat_send to <spawner>, under 1,200 characters in total, starting with',
    'exactly these three lines:',
    `Verdict: MERGE            ${verdicts}`,
    'PR: <owner>/<repo>#<n>',
    'Head: <full 40-hex head sha>',
    ...ciRule,
    'On FIX_FIRST add a fourth line naming the first blocker:',
    'Class: defect|test|pr-text|leak|lint|rebase|ci-red|changeset',
    'then one line `Defect class: <what the blocking items share; the one boundary where a single fix',
    'covers them all>`. On a re-review (brief, PR comments or commits show an earlier FIX_FIRST) add',
    '`Earlier findings:` then one short line per earlier blocking item, `- fixed: <item>` or',
    '`- not fixed: <item>`; fixing one instance literally is not fixed. If you find none, write',
    '`Earlier findings: none found`.',
    PROBE_SANDBOX_RULE,
    REVIEW_TREE_RULE,
    MUTANT_RULE,
    SHIM_RULE,
    REVIEWER_BODY_FILE_RULE,
    QUOTE_RULE,
    GH_READS_RULE,
    "Then blocking items before nits. A verdict counts only when Head equals the PR's current head exactly.",
    FOLLOW_UPS_RULE,
    FRICTION_LINE,
  ].join('\n')

const REVIEWER = reviewerBlock('(or FIX_FIRST)', SHEPHERD_CI_RULE)

/** The reviewer block for a brief carrying `SHEPHERD_NONE_MARKER`: a seat merging on its own reads CI itself. */
export const REVIEWER_WITHOUT_SHEPHERD = reviewerBlock('(or FIX_FIRST or WAIT)', OWN_CI_CHECK)

export const RETURN_CONTRACT_BLOCKS: Readonly<Record<ReturnContract, string>> = {
  implementer: IMPLEMENTER,
  reviewer: REVIEWER,
}
