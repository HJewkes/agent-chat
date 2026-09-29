import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { gitChildEnv } from '../git.js'
import type { RangeSource } from './scan.js'

/** Thrown with a fixed message: git's own stderr can quote file content, so it is never relayed. */
export class ScanError extends Error {}

const execFileAsync = promisify(execFile)

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

const PER_COMMIT = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--diff-merges=first-parent',
]

/** `-z` log output: an empty field comes before each sha, and the first path follows a newline. */
export function parseAddedPaths(raw: string): { sha: string; path: string }[] {
  const fields = raw.split('\0')
  const out: { sha: string; path: string }[] = []
  let sha = ''
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field === '') sha = fields[++i] ?? ''
    else out.push({ sha, path: field.startsWith('\n') ? field.slice(1) : field })
  }
  return out
}

function parseMessages(raw: string): { sha: string; body: string }[] {
  return raw
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(record => record.includes('\0'))
    .map(record => {
      const [sha = '', body = ''] = record.split('\0')
      return { sha, body }
    })
}

export function gitRangeSource(cwd: string): RangeSource {
  const log = (range: string, ...args: string[]): string[] => [
    'log',
    ...PER_COMMIT,
    ...args,
    '--end-of-options',
    range,
  ]
  return {
    diffLines: range => gitLines(log(range, '-p', '--text', '--unified=0', '--format=%x00%H'), cwd),
    addedPaths: async range =>
      parseAddedPaths(
        await gitText(log(range, '--name-only', '-z', '--diff-filter=A', '--format=%x00%H'), cwd),
      ),
    messages: async range =>
      parseMessages(await gitText(log(range, '--no-patch', '--format=%H%x00%B%x1e'), cwd)),
  }
}
