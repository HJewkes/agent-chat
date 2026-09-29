import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { gitChildEnv } from '../../git.js'
import { EMPTY_DENYLIST, loadDenylist } from '../../leak-guard/denylist.js'
import { renderDenylistProblem, renderFindings, renderJson, tildify } from '../../leak-guard/render.js'
import {
  scanRange,
  scanText,
  type Finding,
  type RangeSource,
  type ScanContext,
} from '../../leak-guard/scan.js'
import { denylistPath } from '../../paths.js'

const execFileAsync = promisify(execFile)

export interface LeakScanOptions {
  range?: string
  textFile?: string
  json?: boolean
}

export const EXIT_CLEAN = 0
export const EXIT_FINDINGS = 1
export const EXIT_CANNOT_PASS = 2

/** Thrown with a fixed message: git's own stderr can quote file content, so it is never relayed. */
class ScanError extends Error {}

/** Two dots only: `a...b` means different commits to `git log` and `git diff`. */
const isTwoDotRange = (r: string): boolean => /^[^-\s.][^\s]*\.\.[^-\s.][^\s]*$/.test(r) && !r.includes('...')

const GIT_BASE = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false']

async function* gitLines(args: string[], cwd: string): AsyncIterable<string> {
  const child = spawn('git', [...GIT_BASE, ...args], {
    cwd,
    env: gitChildEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exited = new Promise<number>(resolve => {
    child.on('error', () => resolve(-1))
    child.on('close', code => resolve(code ?? -1))
  })
  const decoder = new StringDecoder('utf8')
  let pending = ''
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    const parts = (pending + decoder.write(chunk)).split('\n')
    pending = parts.pop() ?? ''
    yield* parts
  }
  pending += decoder.end()
  if (pending !== '') yield pending
  if ((await exited) !== 0) throw new ScanError('git could not read that range')
}

async function gitText(args: string[], cwd: string): Promise<string> {
  try {
    const opts = { cwd, env: gitChildEnv(), encoding: 'utf8' as const, maxBuffer: 256 * 1024 * 1024 }
    return (await execFileAsync('git', [...GIT_BASE, ...args], opts)).stdout
  } catch {
    throw new ScanError('git could not read that range')
  }
}

export function gitRangeSource(cwd: string): RangeSource {
  const diff = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']
  return {
    diffLines: range => gitLines(['diff', ...diff, '--text', '--unified=0', '--end-of-options', range], cwd),
    addedPaths: async range =>
      (
        await gitText(
          ['diff', ...diff, '--name-only', '-z', '--diff-filter=A', '--end-of-options', range],
          cwd,
        )
      )
        .split('\0')
        .filter(p => p !== ''),
    messages: async range =>
      (await gitText(['log', '--format=%H%x00%B%x1e', '--end-of-options', range], cwd))
        .split('\x1e')
        .map(record => record.replace(/^\n/, ''))
        .filter(record => record.includes('\0'))
        .map(record => {
          const [sha = '', body = ''] = record.split('\0')
          return { sha, body }
        }),
  }
}

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
