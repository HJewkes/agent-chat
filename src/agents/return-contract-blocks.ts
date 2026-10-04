import type { ReturnContract } from './types.js'

/**
 * CC-286: the one copy of the return contract. `<spawner>` is the only
 * placeholder the broker fills; the rest is for the agent to resolve.
 *
 * Compiled in rather than read from a file: the broker runs from a checkout that
 * agents write to, so a file read at spawn time let any of them reword the
 * contract for every later spawn. A change here needs a build and a restart.
 */

/** A block is paid for on every contracted spawn, so it stays a paragraph. */
export const MAX_BLOCK_CHARS = 2440

const NEVER_PARK =
  'Never end a turn on a background task, a sleep or a ScheduleWakeup: a headless agent exits at ' +
  'turn end and the task dies with it.'

/** CC-647: a logging shim named gh resolved gh to itself and forked until swap ran out. */
const SHIM_RULE =
  'Never put a shim named gh, git, node, npm or pnpm on PATH unless it drops its own dir from PATH ' +
  'first (pattern: src/gh-shim/install.ts).'

/** CC-452: a brief line reading exactly this keeps the implementer off Shepherd for a seat's own merge path. */
export const SHEPHERD_NONE_MARKER = 'Shepherd: none'

const IMPLEMENTER_HEAD = [
  'Check `gh api repos/<owner>/<repo> --jq .visibility`. In a public repo, never put real data',
  'in code, fixtures, PR bodies or comments: task lists, charter or seat files,',
  '/Users paths, emails, or IDs and text from private repos. Use synthetic fixtures.',
  'First, stop if `git log origin/<default> --oneline --grep <ID>` shows it landed.',
  'Branch from origin/<default>; check `git log origin/<default>..HEAD`.',
  'Commit before mutating; never `git checkout` uncommitted work.',
  'Keep scratch in the worktree or `$TMPDIR/<your name>`.',
  'Write PR bodies to a fresh `$TMPDIR/<your name>/pr-body.md`; cat it before `gh-write -- pr create|edit`.',
  'Make each GitHub write via `agent-chat gh-write -- <gh args>`, the only write path; verify',
  'each landed. Plain `gh` is for reads; gh by path is refused. No gh-write: report BLOCKED.',
  'On a 403 "API rate limit exceeded" with core quota left, retry once in 5 minutes.',
]

const SHEPHERD_HANDOFF = [
  'Never use --no-verify. Verify locally, push, open the PR over REST, never wait on CI.',
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
  'Only when the brief asks for a load test: record the PID of each burner, kill only those,',
  'confirm with `pgrep` that none survive, never by name pattern.',
  'A PR narrowing a timeout reports per-case CI times against the new limit.',
  'You are NOT done at "PR opened". Your LAST action must be chat_send to <spawner> starting with',
  '`Status: DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT`, `PR: <owner>/<repo>#<n>` and',
  '`Head: <full sha>` lines, then',
  'CI: <paste of: gh api repos/<owner>/<repo>/commits/<head>/check-runs --paginate --jq \'.check_runs[]|"\\(.name) \\(.conclusion)"\'>,',
]

const ciTail = (ciAt: string): string[] => [
  `${ciAt}, never "green" alone. \`gh run watch\` covers only one`,
  'workflow; a skipped check (std / compat) is no failure, and "required" means the required contexts on',
  'the default branch.',
]

const implementerBlock = (handoff: string[], ciAt: string): string =>
  [...IMPLEMENTER_HEAD, ...handoff, ...IMPLEMENTER_RULES, ...ciTail(ciAt)].join('\n')

const IMPLEMENTER = implementerBlock(SHEPHERD_HANDOFF, 'as it stands at the push (you do not wait for CI)')

/** The implementer block for a brief carrying `SHEPHERD_NONE_MARKER`. */
export const IMPLEMENTER_WITHOUT_SHEPHERD = implementerBlock(
  OWN_CI_WAIT,
  'as it stands at the final head after the wait',
)

const REVIEWER = [
  `Plain-text stdout is invisible to <spawner>. ${NEVER_PARK}`,
  'Your LAST action must be chat_send to <spawner>, under 1,200 characters in total, starting with',
  'exactly these three lines:',
  'Verdict: MERGE            (or FIX_FIRST)',
  'PR: <owner>/<repo>#<n>',
  'Head: <full 40-hex head sha>',
  'Before MERGE, confirm every required check-run (one branch protection names) at the reviewed head',
  'with `gh api repos/<owner>/<repo>/commits/<head>/check-runs --paginate`; FIX_FIRST if a required',
  'one failed. A skipped check (std / compat) is not a failure.',
  'Never run `git stash`: refs/stash is shared across worktrees. Use `git show <rev>:<path>` instead.',
  SHIM_RULE,
  "Then blocking items before nits. A verdict counts only when Head equals the PR's current head exactly.",
].join('\n')

export const RETURN_CONTRACT_BLOCKS: Readonly<Record<ReturnContract, string>> = {
  implementer: IMPLEMENTER,
  reviewer: REVIEWER,
}
