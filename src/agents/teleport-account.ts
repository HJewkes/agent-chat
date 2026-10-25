import os from 'node:os'
import path from 'node:path'
import {
  accountTargetCheck,
  moveTranscript,
  realAccountReaders,
  resolveAccountTarget,
  transcriptMoveBlocker,
  type AccountCheck,
  type AccountTarget,
  type TranscriptMove,
  type TranscriptMoveResult,
} from './account-move.js'
import { accountName, defaultConfigDir } from './config-dir.js'
import { parsePools } from './seats/charter.js'
import { readText } from './seats/io.js'
import { poolForConfigDir } from './seats/spawn-gate-read.js'

/**
 * CC-892 S2: the account side of moving a live session to another account. Teleport ends the
 * session, moves its transcript with these, and resumes the same session id under the target.
 */

/** What the human asked for: the account to move to, and whether the usage refusals are lifted. */
export interface AccountMoveRequest {
  to: string
  force?: boolean
  /** Who asked, for the note the moved session reads. */
  by: string
}

export interface AccountMoveCheck {
  from: AccountTarget
  to: AccountTarget
  cwd: string
  sessionId: string
  force?: boolean
}

/** Injected so a test reads no real login and touches no real transcript. */
export interface AccountMoves {
  resolve(account: string): AccountTarget | { error: string }
  /** Every refusal, the target's and the transcript's, read before anything ends. */
  check(input: AccountMoveCheck): AccountCheck
  move(move: TranscriptMove): TranscriptMoveResult
}

/** What a dry run reads of the session, as `Teleport.accountMove` reads it. */
export interface AccountMoveSubject {
  name: string
  /** True when the session reports the broker's own host: a transcript moves only there. */
  onBrokerHost: boolean
  configDir: string | undefined
  cwd: string
  sessionId: string
}

/**
 * CC-1592: every refusal `Teleport.accountMove` reads, through the same seam, with nothing recorded
 * or ended. A dry run answers from this alone, so it refuses exactly as the move's own check does.
 */
export function accountMoveRefusal(
  accounts: AccountMoves,
  subject: AccountMoveSubject,
  account: AccountMoveRequest,
): string | undefined {
  const kept = `${subject.name} was not ended.`
  if (!subject.onBrokerHost) return `an account move runs only on the broker's host, and stays there. ${kept}`
  const to = accounts.resolve(account.to)
  if ('error' in to) return `${to.error}. ${kept}`
  try {
    const check = accounts.check({
      from: sessionAccount(subject.configDir),
      to,
      cwd: subject.cwd,
      sessionId: subject.sessionId,
      ...(account.force === true ? { force: true } : {}),
    })
    return check.ok ? undefined : `${check.refusals.join('; ')}. ${kept}`
  } catch (err) {
    return `the move to ${account.to} could not be checked: ${(err as Error).message}. ${kept}`
  }
}

/** The target pool's five_hour ceiling from the charter; a dir no pool names gets the hard limit. */
function poolLimits(root: string, dir: string, home: string): { fiveHour?: number } {
  const charter = readText(path.join(root, 'charter.md'))
  const pool = charter === undefined ? undefined : poolForConfigDir(parsePools(charter, home), dir)
  return pool === undefined ? {} : { fiveHour: pool.rule.ceiling_five_hour }
}

export function realAccountMoves(autonomyRoot: string, home: string = os.homedir()): AccountMoves {
  return {
    resolve: account => resolveAccountTarget(account, { home }),
    check: ({ sessionId, ...input }) => {
      const target = accountTargetCheck({
        ...input,
        limits: poolLimits(autonomyRoot, input.to.dir, home),
        readers: realAccountReaders(home),
      })
      const transcript = transcriptMoveBlocker({ ...input, sessionId })
      if (transcript === undefined) return target
      return { ok: false, refusals: [...target.refusals, transcript] }
    },
    move: moveTranscript,
  }
}

/** The account a session runs on; with no config dir it is the default, with the variable unset. */
export const sessionAccount = (configDir: string | undefined, home: string = os.homedir()): AccountTarget =>
  configDir === undefined ? { dir: defaultConfigDir(home), unset: true } : { dir: configDir }

/** `claude` for the unset default, else the dir's own name. */
export const accountLabel = (account: AccountTarget): string =>
  account.unset === true ? 'claude' : accountName(account.dir)

/** Put in place of the teleport preamble: a resumed session needs no account of a handoff. */
export const ACCOUNT_MOVE_PREAMBLE = [
  'This conversation was moved to another Anthropic account and resumed under its same session id.',
  'Everything above is your own history, not a handoff. Your name, peers and working directory are unchanged.',
].join(' ')

/** The first thing the moved session reads, or what it reads when the move fell back to the old account. */
export function moveNote(from: AccountTarget, to: AccountTarget, by: string, failure?: string): string {
  if (failure !== undefined)
    return (
      `${by} asked to move this session from ${accountLabel(from)} to ${accountLabel(to)}, but its ` +
      `transcript could not be moved (${failure}), so it resumed on ${accountLabel(from)}. Carry on.`
    )
  return `This session moved from ${accountLabel(from)} to ${accountLabel(to)} at the request of ${by}. Carry on.`
}
