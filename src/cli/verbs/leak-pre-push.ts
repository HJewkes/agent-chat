import { runGit, type GitRunner } from '../../git.js'
import { EMPTY_DENYLIST, loadDenylist, type DenylistLoad } from '../../leak-guard/denylist.js'
import { renderFindings, tildify } from '../../leak-guard/render.js'
import { scanRange, type Finding, type ScanContext } from '../../leak-guard/scan.js'
import { cachedVisibility, type VisibilityReader } from '../../leak-guard/visibility.js'
import { denylistPath, visibilityCachePath } from '../../paths.js'
import {
  defaultIo,
  EXIT_CANNOT_PASS,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  gitRangeSource,
  leakScan,
  ScanError,
  type LeakScanIo,
  type LeakScanOptions,
  type RevSpec,
} from './leak-scan.js'

export interface PrePushOptions {
  remote: string
  url: string
}

export interface PrePushDeps {
  io: LeakScanIo
  visibility: VisibilityReader
  git?: GitRunner
}

interface RefUpdate {
  localSha: string
  remoteSha: string
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const ZERO = /^0+$/

/** git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line; deletions push nothing. */
export function parseRefUpdates(stdin: string): RefUpdate[] {
  return stdin
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length === 4)
    .map(([, localSha = '', , remoteSha = '']) => ({ localSha, remoteSha }))
    .filter(u => SHA.test(u.localSha) && SHA.test(u.remoteSha) && !ZERO.test(u.localSha))
}

/** Commits the remote does not have yet: not on its tracking refs, and not under the sha it reports. */
async function revSpecFor(update: RefUpdate, remote: string, cwd: string, git: GitRunner): Promise<RevSpec> {
  const remotes = (await git(['remote'], cwd))?.split('\n') ?? []
  const tracking = remotes.includes(remote) ? `--remotes=${remote}` : '--remotes'
  const known =
    !ZERO.test(update.remoteSha) &&
    (await git(['cat-file', '-e', `${update.remoteSha}^{commit}`], cwd)) !== null
  return {
    options: ['--not', tracking, '--not'],
    revs: [update.localSha, ...(known ? [`^${update.remoteSha}`] : [])],
  }
}

async function pushFindings(
  updates: RefUpdate[],
  opts: PrePushOptions,
  ctx: ScanContext,
  cwd: string,
  git: GitRunner,
): Promise<Finding[]> {
  const seen = new Map<string, Finding>()
  for (const update of updates) {
    const spec = await revSpecFor(update, opts.remote, cwd, git)
    const found = await scanRange(
      update.localSha,
      ctx,
      gitRangeSource(cwd, () => spec),
    )
    for (const f of found) seen.set(`${f.commit ?? ''}:${f.fingerprint}`, f)
  }
  return [...seen.values()]
}

/** Never quotes the file; a reason is a fixed phrase from the loader. */
function denylistNote(load: DenylistLoad, io: LeakScanIo): string | undefined {
  const where = tildify(denylistPath(), io.home)
  if (load.kind === 'missing' || load.kind === 'empty')
    return `leak-scan: no deny-list ${load.kind === 'empty' ? 'entries ' : ''}at ${where}, so only home-path was checked. See docs/leak-guard.md.`
  if (load.kind === 'unreadable')
    return `leak-scan: the deny-list at ${where} ${load.reason}, so the push is refused unless the remote is private. Fix its permissions or delete it; see docs/leak-guard.md.`
  return undefined
}

/**
 * A missing or empty deny-list enforces home-path only and lets a clean push through, so the
 * guard can ship before the owner writes the file. An unreadable one refuses, since it was meant to exist.
 */
export async function leakPrePush(opts: PrePushOptions, stdin: string, deps: PrePushDeps): Promise<number> {
  const { io } = deps
  const load = loadDenylist(denylistPath())
  const ctx = { list: load.kind === 'ok' ? load.list : EMPTY_DENYLIST, home: io.home }
  let findings: Finding[]
  try {
    findings = await pushFindings(parseRefUpdates(stdin), opts, ctx, io.cwd, deps.git ?? runGit)
  } catch (err) {
    io.err(`leak-scan: ${err instanceof ScanError ? err.message : 'the scan failed'}, so the push is refused`)
    return EXIT_CANNOT_PASS
  }
  const note = denylistNote(load, io)
  if (note) io.err(note)
  if (findings.length === 0 && load.kind !== 'unreadable') return EXIT_CLEAN
  renderFindings(findings).forEach(io.err)
  // A reader that throws, even synchronously, has not shown the remote is private.
  const visibility = await Promise.resolve()
    .then(() => deps.visibility(opts.url))
    .catch(() => 'unknown' as const)
  if (visibility === 'private') {
    io.err('leak-scan: the remote is private, so this is a warning and the push goes ahead.')
    return EXIT_CLEAN
  }
  io.err(
    `leak-scan: push refused: the remote is ${visibility === 'public' ? 'public' : 'of unknown visibility'}.`,
  )
  return findings.length > 0 ? EXIT_FINDINGS : EXIT_CANNOT_PASS
}

export interface LeakScanCliOptions extends LeakScanOptions {
  prePush?: boolean
  remote?: string
  url?: string
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function leakScanCommand(options: LeakScanCliOptions): Promise<number> {
  const { prePush, remote, url, ...scan } = options
  if (!prePush) return leakScan(scan)
  const io = defaultIo()
  if (remote === undefined || url === undefined || scan.range !== undefined || scan.textFile !== undefined) {
    io.err('leak-scan: --pre-push takes --remote and --url, and neither --range nor --text-file')
    return EXIT_CANNOT_PASS
  }
  const visibility = cachedVisibility(visibilityCachePath())
  return leakPrePush({ remote, url }, await readStdin(), { io, visibility })
}
