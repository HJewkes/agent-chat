import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { childEnv } from '../../exec.js'

/**
 * CC-1064: a squash merge leaves the PR's commits nowhere on origin once the head branch is deleted, so
 * park asks GitHub which merged PRs had that head branch and checks HEAD against each PR's head commit.
 */

const execFileAsync = promisify(execFile)

const READ_TIMEOUT_MS = 15_000

export interface MergedPr {
  number: number
  headSha: string
}

/** Merged PRs whose head was `branch`; rejects when it cannot tell, which park treats as a refusal. */
export type MergedPrReader = (gitRoot: string, branch: string) => Promise<MergedPr[]>

export function parseMergedPrs(stdout: string): MergedPr[] {
  const prs: unknown = JSON.parse(stdout)
  if (!Array.isArray(prs)) throw new Error('gh pr list did not answer a JSON array')
  return prs.map((pr: { number?: unknown; headRefOid?: unknown }) => {
    if (typeof pr.number !== 'number' || typeof pr.headRefOid !== 'string')
      throw new Error('gh pr list answered a PR without number and headRefOid')
    return { number: pr.number, headSha: pr.headRefOid }
  })
}

/** A repo with no origin has nowhere to hold a PR; otherwise `gh` answers, and its failure rejects. */
export const readMergedPrs: MergedPrReader = async (gitRoot, branch) => {
  const opts = { cwd: gitRoot, env: childEnv(), encoding: 'utf8' as const, timeout: READ_TIMEOUT_MS }
  const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], opts).catch(() => null)
  if (remote === null) return []
  const fields = 'number,headRefOid,mergedAt'
  const args = ['pr', 'list', '--head', branch, '--state', 'merged', '--json', fields, '--limit', '5']
  const { stdout } = await execFileAsync('gh', args, opts)
  return parseMergedPrs(stdout)
}
