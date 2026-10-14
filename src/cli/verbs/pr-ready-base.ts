import type { Run, RunResult } from './pr-ready.js'

const ORIGIN_PREFIX = 'refs/remotes/origin/'

export interface ResolvedBase {
  ref: string
  /** Printed on the base step: the bare ref for the default branch, else the ref and its source. */
  reason: string
}

interface OpenPr {
  number: number
  baseRefName?: unknown
}

const text = (result: RunResult): string => result.output.trim()
const shortName = (ref: string): string => ref.slice('refs/remotes/'.length)
const recordKey = (branch: string): string => `branch.${branch}.agent-chat-base`

/** Undefined when gh fails or answers something that is not a list: no answer, not "no PR". */
async function openPrs(run: Run, cwd: string, branch: string): Promise<OpenPr[] | undefined> {
  const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,baseRefName']
  const result = await run('gh', args, cwd)
  if (result.code !== 0) return undefined
  try {
    const list: unknown = JSON.parse(text(result))
    return Array.isArray(list) ? (list as OpenPr[]) : undefined
  } catch {
    return undefined
  }
}

const validBranch = async (run: Run, cwd: string, name: string): Promise<boolean> =>
  (await run('git', ['check-ref-format', '--branch', name], cwd)).code === 0

async function prBase(run: Run, cwd: string, branch: string): Promise<ResolvedBase | undefined> {
  const prs = (await openPrs(run, cwd, branch)) ?? []
  const [pr, ...others] = prs
  if (pr === undefined) return undefined
  if (others.length > 0) {
    const listed = prs.map(each => `#${each.number} -> ${String(each.baseRefName)}`).join(', ')
    throw new Error(`${branch} has several open PRs (${listed}); cannot tell the base`)
  }
  if (typeof pr.baseRefName !== 'string' || !(await validBranch(run, cwd, pr.baseRefName))) return undefined
  return { ref: `${ORIGIN_PREFIX}${pr.baseRefName}`, reason: `PR #${pr.number} base` }
}

async function recordedBase(run: Run, cwd: string, branch: string): Promise<ResolvedBase | undefined> {
  const record = await run('git', ['config', '--get', recordKey(branch)], cwd)
  const name = text(record)
  if (record.code !== 0 || name === '') return undefined
  if (!(await validBranch(run, cwd, name))) {
    throw new Error(
      `${recordKey(branch)} is ${name}, not a branch name; fix it with git config ${recordKey(branch)} <name>`,
    )
  }
  return { ref: `${ORIGIN_PREFIX}${name}`, reason: 'recorded' }
}

/**
 * Origin branches HEAD contains that the default branch does not, other than this branch's own:
 * origin/<branch> and its upstream, which may be the branch pushed under another name (CC-824).
 */
async function stackCandidates(run: Run, cwd: string, branch: string, def: string): Promise<string[]> {
  const args = ['for-each-ref', '--format=%(refname)', '--merged', 'HEAD', '--no-merged', def, ORIGIN_PREFIX]
  const refs = await run('git', args, cwd)
  if (refs.code !== 0) throw new Error(`git for-each-ref failed: ${text(refs).split('\n').pop()}`)
  const upstream = await run('git', ['rev-parse', '--symbolic-full-name', '@{upstream}'], cwd)
  const own = new Set([`${ORIGIN_PREFIX}HEAD`, def, `${ORIGIN_PREFIX}${branch}`])
  if (upstream.code === 0) own.add(text(upstream))
  return text(refs)
    .split('\n')
    .map(ref => ref.trim())
    .filter(ref => ref !== '' && !own.has(ref))
}

const isAncestor = async (run: Run, cwd: string, a: string, b: string): Promise<boolean> =>
  (await run('git', ['merge-base', '--is-ancestor', a, b], cwd)).code === 0

/** Drops each candidate that is strictly below another: the nearest parent is the base. */
async function nearest(run: Run, cwd: string, refs: string[]): Promise<string[]> {
  const kept: string[] = []
  for (const ref of refs) {
    let below = false
    for (const other of refs) {
      if (other === ref || below) continue
      below = (await isAncestor(run, cwd, ref, other)) && !(await isAncestor(run, cwd, other, ref))
    }
    if (!below) kept.push(ref)
  }
  return kept
}

function cannotTell(branch: string, def: string, candidates: string[]): Error {
  const named = candidates.map(shortName).join(', ')
  return new Error(
    `HEAD contains commits of ${named} not on ${shortName(def)}; cannot tell the base: record it with ` +
      `git config ${recordKey(branch)} <name> (use ${def.slice(ORIGIN_PREFIX.length)} if the parent merged)`,
  )
}

async function inferredBase(
  run: Run,
  cwd: string,
  branch: string,
  def: string,
): Promise<ResolvedBase | undefined> {
  const candidates = await nearest(run, cwd, await stackCandidates(run, cwd, branch, def))
  const [parent, ...others] = candidates
  if (parent === undefined) return undefined
  if (others.length > 0) throw cannotTell(branch, def, candidates)
  const prs = await openPrs(run, cwd, parent.slice(ORIGIN_PREFIX.length))
  const pr = prs?.length === 1 ? prs[0] : undefined
  if (pr === undefined) throw cannotTell(branch, def, candidates)
  return { ref: parent, reason: `stacked on ${shortName(parent)} (PR #${pr.number})` }
}

async function sourcedBase(run: Run, cwd: string, def: string): Promise<ResolvedBase | undefined> {
  const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)
  if (head.code !== 0) return undefined
  const branch = text(head)
  return (
    (await prBase(run, cwd, branch)) ??
    (await recordedBase(run, cwd, branch)) ??
    (await inferredBase(run, cwd, branch, def))
  )
}

/**
 * CC-1281: the base is the open PR's base branch, else the recorded `branch.<b>.agent-chat-base`,
 * else the one nearest origin branch HEAD is stacked on that has an open PR, else `def`. Throws,
 * naming the candidates and the git config remedy, when it cannot tell.
 */
export async function resolveBase(run: Run, cwd: string, def: string): Promise<ResolvedBase> {
  const found = await sourcedBase(run, cwd, def)
  if (found === undefined || found.ref === def) return { ref: def, reason: def }
  return { ref: found.ref, reason: `${found.ref} (${found.reason})` }
}
