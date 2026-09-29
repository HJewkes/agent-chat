import fs from 'node:fs'
import os from 'node:os'
import { EMPTY_DENYLIST, loadDenylist } from '../../leak-guard/denylist.js'
import { gitRangeSource, ScanError } from '../../leak-guard/git-source.js'
import { renderDenylistProblem, renderFindings, renderJson, tildify } from '../../leak-guard/render.js'
import { scanRange, scanText, type Finding, type ScanContext } from '../../leak-guard/scan.js'
import { denylistPath } from '../../paths.js'

export interface LeakScanOptions {
  range?: string
  textFile?: string
  json?: boolean
}

export const EXIT_CLEAN = 0
export const EXIT_FINDINGS = 1
export const EXIT_CANNOT_PASS = 2

/** Two dots only: `a...b` means different commits to `git log` and `git diff`. */
const isTwoDotRange = (r: string): boolean => /^[^-\s.][^\s]*\.\.[^-\s.][^\s]*$/.test(r) && !r.includes('...')

function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    throw new ScanError('the --text-file could not be read')
  }
}

async function findingsFor(opts: LeakScanOptions, ctx: ScanContext, cwd: string): Promise<Finding[]> {
  if (opts.textFile !== undefined) return scanText(readTextFile(opts.textFile), ctx, '<text>')
  const range = opts.range ?? ''
  if (!isTwoDotRange(range)) throw new ScanError('--range must look like <from>..<to>')
  return scanRange(range, ctx, gitRangeSource(cwd))
}

export interface LeakScanIo {
  out: (line: string) => void
  err: (line: string) => void
  home: string
  cwd: string
}

const defaultIo = (): LeakScanIo => ({
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  home: os.homedir(),
  cwd: process.cwd(),
})

/** 0 clean, 1 findings, 2 when the scan cannot pass: no usable deny-list, bad input or a git failure. */
export async function leakScan(opts: LeakScanOptions, io: LeakScanIo = defaultIo()): Promise<number> {
  if ((opts.range === undefined) === (opts.textFile === undefined)) {
    io.err('leak-scan: pass exactly one of --range <from>..<to> or --text-file <file>')
    return EXIT_CANNOT_PASS
  }
  const load = loadDenylist(denylistPath())
  const ctx = { list: load.kind === 'ok' ? load.list : EMPTY_DENYLIST, home: io.home }
  let findings: Finding[]
  try {
    findings = await findingsFor(opts, ctx, io.cwd)
  } catch (err) {
    io.err(`leak-scan: ${err instanceof ScanError ? err.message : 'the scan failed'}`)
    return EXIT_CANNOT_PASS
  }
  if (opts.json) io.out(renderJson(findings, load.kind))
  else renderFindings(findings).forEach(io.out)
  const problem = renderDenylistProblem(load, tildify(denylistPath(), io.home))
  if (problem) io.err(problem)
  if (findings.length > 0) return EXIT_FINDINGS
  return problem ? EXIT_CANNOT_PASS : EXIT_CLEAN
}
