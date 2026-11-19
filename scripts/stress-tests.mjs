#!/usr/bin/env node
/**
 * CC-1743: reruns test files under synthetic CPU and disk load, to prove a flake fixed, not lucky.
 *
 *   node scripts/stress-tests.mjs [--runs 50] [--parallel 10] [--burners <cores>] [--flushers 8] -- <files...>
 *
 * Starts `--burners` busy-loop children and `--flushers` children that write and fsync a temp
 * file in a loop (verify's flakes came from commits waiting on a contended disk). Then it runs
 * `vitest run <files>` `--runs` times, `--parallel` at once, and prints each failing run's
 * output and a pass count. It kills only
 * the pids it started, and exits 1 when any run failed.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VITEST = path.join(ROOT, 'node_modules', '.bin', 'vitest')
const BURN = 'for(;;){}'
const FLUSH = `const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stress-flush-'))
process.on('SIGTERM', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0) })
const fd = fs.openSync(path.join(dir, 'f'), 'w'), block = Buffer.alloc(4096, 1)
const loop = () => { fs.writeSync(fd, block, 0, block.length, 0); fs.fsyncSync(fd); setImmediate(loop) }
loop()`

function parseArgs(argv) {
  const split = argv.indexOf('--')
  const flags = split === -1 ? argv : argv.slice(0, split)
  const files = split === -1 ? [] : argv.slice(split + 1)
  const value = (name, fallback) => {
    const at = flags.indexOf(name)
    return at === -1 ? fallback : Number(flags[at + 1])
  }
  const options = {
    runs: value('--runs', 50),
    parallel: value('--parallel', 10),
    burners: value('--burners', os.availableParallelism()),
    flushers: value('--flushers', 8),
    files,
  }
  if (files.length === 0) throw new Error('name the test files after --')
  return options
}

function startLoad({ burners, flushers }) {
  const start = script => spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  return [
    ...Array.from({ length: burners }, () => start(BURN)),
    ...Array.from({ length: flushers }, () => start(FLUSH)),
  ]
}

function stopLoad(children) {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
}

function runOnce(files) {
  return new Promise(resolve => {
    const child = spawn(VITEST, ['run', ...files], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('close', code => resolve({ ok: code === 0, output }))
  })
}

async function runAll({ runs, parallel, files }) {
  const results = []
  let next = 0
  const lane = async () => {
    while (next < runs) {
      const index = next++
      const result = await runOnce(files)
      results.push(result)
      process.stdout.write(`run ${index + 1}/${runs}: ${result.ok ? 'pass' : 'FAIL'}\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, runs) }, lane))
  return results
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const load = startLoad(options)
  const stop = () => stopLoad(load)
  process.on('exit', stop)
  process.on('SIGINT', () => process.exit(130))
  process.stdout.write(`load pids: ${load.map(child => child.pid).join(' ')}\n`)
  const started = Date.now()
  const results = await runAll(options)
  stop()
  const failed = results.filter(r => !r.ok)
  for (const run of failed) process.stdout.write(`\n--- failing run ---\n${run.output}\n`)
  const seconds = Math.round((Date.now() - started) / 1000)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed in ${seconds}s\n`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
