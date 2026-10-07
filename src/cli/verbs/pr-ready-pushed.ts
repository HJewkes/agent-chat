import type { Run, RunResult } from './pr-ready.js'

const REMOTE_PREFIX = 'refs/remotes/'
const ORIGIN_PREFIX = `${REMOTE_PREFIX}origin/`

export interface PushedOutcome {
  ok: boolean
  reason: string
}

const text = (result: RunResult): string => result.output.trim()

/** The ref the branch was pushed to: its upstream, else origin/<branch>; never the base itself. */
async function pushedRef(run: Run, cwd: string, base: string): Promise<string | undefined> {
  const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
  if (branch.code !== 0) return undefined
  const upstream = await run('git', ['rev-parse', '--symbolic-full-name', '@{upstream}'], cwd)
  const candidates = [upstream.code === 0 ? text(upstream) : '', `${ORIGIN_PREFIX}${text(branch)}`]
  for (const ref of candidates) {
    if (ref === '' || ref === base) continue
    if ((await run('git', ['rev-parse', '--verify', '--quiet', ref], cwd)).code === 0) return ref
  }
  return undefined
}

async function count(run: Run, cwd: string, range: string): Promise<number> {
  const result = await run('git', ['rev-list', '--count', range], cwd)
  return result.code === 0 ? Number(text(result)) : 0
}

/**
 * CC-734: a pushed branch is never rebased, since the rebase would leave local HEAD ahead of the PR
 * head. Returns undefined when the branch has no pushed ref, so the caller rebases as before.
 */
export async function pushedBranchStep(
  run: Run,
  cwd: string,
  base: string,
  strict: boolean,
): Promise<PushedOutcome | undefined> {
  const pushed = await pushedRef(run, cwd, base)
  if (!pushed) return undefined
  const refspec = `+refs/heads/${base.slice(ORIGIN_PREFIX.length)}:${base}`
  const fetch = await run('git', ['fetch', '--quiet', 'origin', refspec], cwd)
  if (fetch.code !== 0) return { ok: false, reason: `git fetch failed: ${text(fetch).split('\n').pop()}` }
  const baseName = base.slice(REMOTE_PREFIX.length)
  const unpushed = await count(run, cwd, `${pushed}..HEAD`)
  const note =
    unpushed > 0 ? `; ${unpushed} local commit(s) not pushed to ${pushed.slice(REMOTE_PREFIX.length)}` : ''
  if ((await count(run, cwd, `HEAD..${base}`)) === 0)
    return { ok: true, reason: `not behind ${baseName}${note}` }
  return { ok: !strict, reason: `behind ${baseName}, branch already pushed; not rebasing${note}` }
}

const revision = async (run: Run, cwd: string, ref: string): Promise<string | undefined> => {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', ref], cwd)
  return result.code === 0 ? text(result) : undefined
}

/** CC-824: basement-suite fetches the branch from origin, so it only sees a head that is pushed. */
export async function headIsPushed(run: Run, cwd: string, base: string): Promise<boolean> {
  const pushed = await pushedRef(run, cwd, base)
  if (!pushed) return false
  const head = await revision(run, cwd, 'HEAD')
  return head !== undefined && head === (await revision(run, cwd, pushed))
}
