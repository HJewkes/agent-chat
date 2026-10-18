// Original CLI metadata and original producer bodies have separate owned fixture boundaries.
import { deepStrictEqual } from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  decodeExactUtf8,
  exposeOnlyOwnedOriginalAction,
  isolateOnlyOwnedActionBody,
  exactDependencyModule,
} from './ledger-fixture-ast.js'
import {
  dependencyImplementations,
  controllerProbeEntry,
  fullCliProbeEntry,
  fullCliFakeAction,
} from './ledger-fixture-deps.js'

const bytes = 8 * 1024 * 1024
const late = 'late-callback\n'
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const roots: string[] = []
const locations = {
  doctor: ['dist/cli/doctor-lifecycle.js', 'doctorLifecycle'],
  backfill: ['dist/cli/lifecycle.js', 'backfill'],
} as const
type Controller = keyof typeof locations
let cliRoot: string
let producerRoot: string

function ownedModule(root: string, relative: string) {
  const resolved = path.resolve(root, relative)
  expect(resolved.startsWith(root + path.sep)).toBe(true)
  expect(fs.realpathSync(resolved)).toBe(resolved)
  expect(fs.lstatSync(resolved).isFile()).toBe(true)
  expect(fs.lstatSync(resolved).isSymbolicLink()).toBe(false)
  return resolved
}

function copyTree(mode: 'cli' | 'producer') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-' + mode + '-')))
  roots.push(root)
  fs.cpSync(path.resolve('dist'), path.join(root, 'dist'), { recursive: true })
  fs.copyFileSync('package.json', path.join(root, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
  const proofs = []
  for (const [relative, action] of Object.values(locations)) {
    const copied = ownedModule(root, relative)
    const original = fs.readFileSync(relative)
    expect(fs.readFileSync(copied)).toEqual(original)
    const text = decodeExactUtf8(original)
    const isolated =
      mode === 'cli' ? isolateOnlyOwnedActionBody(text, action) : exposeOnlyOwnedOriginalAction(text, action)
    fs.writeFileSync(copied, isolated.source)
    proofs.push({ mode, relative, ...isolated.proof })
  }
  expect(fs.readFileSync(ownedModule(root, 'dist/cli/index.js'))).toEqual(
    fs.readFileSync('dist/cli/index.js'),
  )
  if (mode === 'producer') {
    for (const [relative, implementations] of Object.entries(dependencyImplementations)) {
      const copied = ownedModule(root, relative)
      expect(fs.readFileSync(copied)).toEqual(fs.readFileSync(relative))
      const original = decodeExactUtf8(fs.readFileSync(copied))
      const generated = exactDependencyModule(original, implementations)
      fs.writeFileSync(copied, generated)
      proofs.push({
        mode,
        relative,
        originalDependencySha256: sha(original),
        fakeDependencySha256: sha(generated),
      })
    }
  }
  const marker = '/* EXACT_FAKE_ACTION_INSERTION_POINT */'
  expect(fullCliProbeEntry.split(marker)).toHaveLength(2)
  const entry = mode === 'cli' ? fullCliProbeEntry.replace(marker, fullCliFakeAction) : controllerProbeEntry
  fs.writeFileSync(path.join(root, 'entry.mjs'), entry)
  const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'entry.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(syntax.error).toBeUndefined()
  expect(syntax.status, syntax.stderr.toString()).toBe(0)
  expect(syntax.signal).toBeNull()
  fs.writeFileSync(path.join(root, 'proof-manifest.json'), JSON.stringify(proofs, null, 2) + '\n')
  console.info('LEDGER_BOUNDARY_PROOF', JSON.stringify(proofs))
  return root
}

beforeAll(() => {
  cliRoot = copyTree('cli')
  producerRoot = copyTree('producer')
})
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

type Probe = {
  name: string
  controller: Controller
  argv?: string[]
  options?: Record<string, boolean | number>
  expectedCode: number
  awaited?: boolean
  assigned?: number
  immediate?: number
  failure?: string
  stdout?: number[]
  stderr?: number[]
  failAt?: string
  fileExists?: boolean
  socketAlive?: boolean
  meta?: { port: number }
  status?: number
  report?: object
  plan?: object[]
  backfillOutcome?: object
  expectedOpen?: number
  expectedClose?: number
  expectedClosed?: number
}
type Proof = { events: unknown[]; openCount?: number; closeAttempts?: number; closedCount?: number }

// Replace only bytes spelling this run's exact owned root. Preserve every other byte.
function canonicalOwnedBytes(data: Buffer, root: string) {
  const needle = Buffer.from(root)
  const canonical = Buffer.from('/synthetic/ledger-fixture')
  const parts: Buffer[] = []
  let offset = 0
  for (;;) {
    const found = data.indexOf(needle, offset)
    if (found === -1) break
    parts.push(data.subarray(offset, found), canonical)
    offset = found + needle.length
  }
  parts.push(data.subarray(offset))
  return Buffer.concat(parts)
}

function runProbe(root: string, sample: Probe, index: number, layer: 'cli' | 'producer') {
  const proofFile = path.join(root, layer + '-' + sample.controller + '-' + index + '.json')
  const child = spawnSync(process.execPath, [path.join(root, 'entry.mjs')], {
    cwd: root,
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: root,
      AGENT_CHAT_HOME: path.join(root, 'home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      NODE_ENV: 'test',
      NO_COLOR: '1',
      FIXTURE_CASE: JSON.stringify(sample),
      FIXTURE_PROOF: proofFile,
    },
  })
  expect(child.error, sample.name).toBeUndefined()
  expect(child.signal, sample.name).toBeNull()
  expect(
    child.status,
    sample.name +
      '\nstdoutHex=' +
      child.stdout.toString('hex') +
      '\nstderrHex=' +
      child.stderr.toString('hex') +
      '\nproof=' +
      (fs.existsSync(proofFile) ? fs.readFileSync(proofFile, 'utf8') : '<absent>'),
  ).toBe(sample.expectedCode)
  expect(fs.existsSync(proofFile), sample.name).toBe(true)
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')) as Proof
  expect(proof.events, sample.name).not.toContainEqual({ unexpectedIo: true })
  expect(child.stderr.toString('utf8'), sample.name).not.toMatch(
    /unexpected ledger business IO|unrepresentable original|missing owned test-only|unknown synthetic/,
  )
  expect(proof.events.slice(0, 2), sample.name).toEqual(
    layer === 'cli'
      ? ['before-cli-import', 'after-cli-import']
      : ['before-controller-import', 'after-controller-import'],
  )
  if (sample.awaited) expect(proof.events.indexOf('awaited')).toBeLessThan(proof.events.indexOf('completed'))
  if (sample.immediate !== undefined || sample.failure) expect(proof.events).not.toContain('completed')
  if (layer === 'producer') {
    expect(proof.openCount, sample.name).toBe(sample.expectedOpen ?? 0)
    expect(proof.closeAttempts, sample.name).toBe(sample.expectedClose ?? 0)
    expect(proof.closedCount, sample.name).toBe(sample.expectedClosed ?? sample.expectedClose ?? 0)
    // Fakes never create an actual database; this check uses the parent namespace.
    expect(fs.existsSync(path.join(root, 'home', 'events.db'))).toBe(false)
  }
  return {
    name: sample.name,
    argv: sample.argv ?? [],
    options: sample.options ?? {},
    code: child.status,
    stdoutHex: canonicalOwnedBytes(child.stdout, root).toString('hex'),
    stderrHex: canonicalOwnedBytes(child.stderr, root).toString('hex'),
    proof,
  }
}

function fakeActionCases(controller: Controller): Probe[] {
  const prefix = controller === 'doctor' ? ['doctor', 'lifecycle'] : ['lifecycle', 'backfill']
  const base: Probe = { name: 'omitted options', controller, argv: prefix, expectedCode: 7 }
  const cases: Probe[] = [
    base,
    { ...base, name: 'help', argv: [...prefix, '--help'], expectedCode: 0 },
    { ...base, name: 'unknown option', argv: [...prefix, '--unknown'], expectedCode: 1 },
    { ...base, name: 'extra argument', argv: [...prefix, 'extra'], expectedCode: 1 },
    { ...base, name: 'awaited', awaited: true },
    { ...base, name: 'assigned one natural', assigned: 1, expectedCode: 1 },
    { ...base, name: 'assigned zero natural', assigned: 0, expectedCode: 0 },
    { ...base, name: 'immediate two', immediate: 2, expectedCode: 2 },
    { ...base, name: 'immediate one', immediate: 1, expectedCode: 1 },
    ...['error', 'code69', 'object', 'array', 'string', 'number', 'null', 'undefined'].map(failure => ({
      ...base,
      name: 'rejected ' + failure,
      failure,
      stdout: [112, 97, 114, 116, 105, 97, 108, 0, 255],
      expectedCode: 1,
    })),
  ]
  if (controller === 'doctor')
    return [
      ...cases,
      { ...base, name: 'offline', argv: [...prefix, '--offline'] },
      { ...base, name: 'repeated offline', argv: [...prefix, '--offline', '--offline'] },
      {
        ...base,
        name: 'offline with value is excess',
        argv: [...prefix, '--offline', 'false'],
        expectedCode: 1,
      },
      { ...base, name: 'unknown negation', argv: [...prefix, '--no-offline'], expectedCode: 1 },
    ]
  return [
    ...cases,
    { ...base, name: 'dry run', argv: [...prefix, '--dry-run'] },
    { ...base, name: 'repeated dry run', argv: [...prefix, '--dry-run', '--dry-run'] },
    ...['1', '0.5', '1e2', '0x10', ' 2 '].map(value => ({
      ...base,
      name: 'valid Number ' + JSON.stringify(value),
      argv: [...prefix, '--since', value],
    })),
    ...['', ' ', '0', '-0', '-1', 'NaN', 'Infinity', '1junk'].map(value => ({
      ...base,
      name: 'invalid Number ' + JSON.stringify(value),
      argv: [...prefix, '--since', value],
      expectedCode: 1,
    })),
    { ...base, name: 'valid repeats', argv: [...prefix, '--since', '1', '--since', '2', '--dry-run'] },
    {
      ...base,
      name: 'valid then invalid',
      argv: [...prefix, '--since', '1', '--since', 'bad'],
      expectedCode: 1,
    },
    {
      ...base,
      name: 'invalid then valid',
      argv: [...prefix, '--since', 'bad', '--since', '1'],
      expectedCode: 1,
    },
    {
      ...base,
      name: 'invalid then unknown',
      argv: [...prefix, '--since', 'bad', '--unknown'],
      expectedCode: 1,
    },
    {
      ...base,
      name: 'unknown then invalid',
      argv: [...prefix, '--unknown', '--since', 'bad'],
      expectedCode: 1,
    },
    { ...base, name: 'invalid then excess', argv: [...prefix, '--since', 'bad', 'extra'], expectedCode: 1 },
    { ...base, name: 'excess then invalid', argv: [...prefix, 'extra', '--since', 'bad'], expectedCode: 1 },
    { ...base, name: 'missing value', argv: [...prefix, '--since'], expectedCode: 1 },
    { ...base, name: 'missing before unknown', argv: [...prefix, '--since', '--unknown'], expectedCode: 1 },
  ]
}

const report = {
  checked_at: 1758600000000,
  shadow: 'on',
  divergences: {},
  unclassified: 0,
  shadow_errors: 0,
  items: [],
  unlisted_repos: [],
}
const planned = {
  agentId: 'synthetic-agent',
  name: 'synthetic-name',
  requestKey: 'backfill:synthetic-agent',
  phases: ['prepared', 'dispatching'],
  sources: [],
  transitions: [],
}

function producerCases(controller: Controller): Probe[] {
  if (controller === 'doctor') {
    const base: Probe = { name: 'online clean natural', controller, report, expectedCode: 7 }
    const offline = { ...base, options: { offline: true }, expectedOpen: 1, expectedClose: 1 }
    return [
      base,
      { ...base, name: 'metadata port', meta: { port: 17600 } },
      { ...base, name: 'online null shadow errors', report: { ...report, shadow_errors: null } },
      {
        ...base,
        name: 'online shadow error immediate one',
        report: { ...report, shadow_errors: 1 },
        expectedCode: 1,
      },
      {
        ...base,
        name: 'online unclassified immediate one',
        report: {
          ...report,
          unclassified: 1,
          divergences: { live_only: 1 },
          items: [
            {
              check: 'held',
              class: 'live_only',
              unclassified: true,
              id: 'synthetic-id',
              name: 'synthetic',
              detail: 'synthetic divergence',
            },
          ],
        },
        expectedCode: 1,
      },
      {
        ...base,
        name: 'HTTP refusal immediate two',
        status: 500,
        report: { error: 'synthetic refusal' },
        expectedCode: 2,
      },
      { ...base, name: 'HTTP body failure fallback two', status: 500, failAt: 'fetch.json', expectedCode: 2 },
      { ...base, name: 'fetch failure becomes refusal two', failAt: 'fetch', expectedCode: 2 },
      { ...base, name: 'success body failure becomes refusal two', failAt: 'fetch.json', expectedCode: 2 },
      {
        ...base,
        name: 'metadata rejection legacy one',
        failAt: 'readMeta',
        failure: 'object',
        expectedCode: 1,
      },
      {
        ...base,
        name: 'token rejection legacy one',
        failAt: 'readToken',
        failure: 'code69',
        expectedCode: 1,
      },
      {
        ...offline,
        name: 'offline missing file no DB',
        fileExists: false,
        expectedOpen: 0,
        expectedClose: 0,
        expectedCode: 2,
      },
      { ...offline, name: 'offline clean closes' },
      {
        ...offline,
        name: 'constructor failure no close',
        failAt: 'EventLog.new',
        expectedOpen: 0,
        expectedClose: 0,
        expectedCode: 1,
      },
      ...['EventLog.handle', 'gather', 'reportFrom'].map(failAt => ({
        ...offline,
        name: failAt + ' failure closes',
        failAt,
        expectedCode: 1,
      })),
      {
        ...offline,
        name: 'close failure propagates',
        failAt: 'EventLog.close',
        expectedClosed: 0,
        expectedCode: 1,
      },
    ]
  }
  const outcome = { planned: [planned], applied: 1, rejected: [] }
  const base: Probe = {
    name: 'normal backfill closes',
    controller,
    backfillOutcome: outcome,
    plan: [planned],
    expectedOpen: 1,
    expectedClose: 1,
    expectedCode: 7,
  }
  return [
    base,
    { ...base, name: 'dry run plan only', options: { dryRun: true } },
    { ...base, name: 'since forwarded', options: { since: 0.5 } },
    { ...base, name: 'dry run since forwarded', options: { dryRun: true, since: 2 } },
    {
      ...base,
      name: 'socket refusal before file and DB',
      socketAlive: true,
      expectedOpen: 0,
      expectedClose: 0,
      expectedCode: 1,
    },
    {
      ...base,
      name: 'missing file before DB',
      fileExists: false,
      expectedOpen: 0,
      expectedClose: 0,
      expectedCode: 1,
    },
    {
      ...base,
      name: 'probe rejection before DB',
      failAt: 'probeSocket',
      failure: 'object',
      expectedOpen: 0,
      expectedClose: 0,
      expectedCode: 1,
    },
    {
      ...base,
      name: 'exists failure before DB',
      failAt: 'existsSync',
      expectedOpen: 0,
      expectedClose: 0,
      expectedCode: 1,
    },
    {
      ...base,
      name: 'constructor failure no close',
      failAt: 'EventLog.new',
      expectedOpen: 0,
      expectedClose: 0,
      expectedCode: 1,
    },
    { ...base, name: 'fence failure closes', failAt: 'shadowSupervisorId', expectedCode: 1 },
    { ...base, name: 'run failure closes', failAt: 'runBackfill', failure: 'object', expectedCode: 1 },
    {
      ...base,
      name: 'plan failure closes',
      options: { dryRun: true },
      failAt: 'planFromSource',
      expectedCode: 1,
    },
    {
      ...base,
      name: 'rejected rows natural one',
      backfillOutcome: {
        planned: [planned, { ...planned, agentId: 'synthetic-second' }],
        applied: 0,
        rejected: [
          { agentId: 'synthetic-agent', kind: 'prepared', reason: 'first refusal' },
          { agentId: 'synthetic-second', kind: 'prepared', reason: 'second refusal' },
        ],
      },
      expectedCode: 1,
    },
    {
      ...base,
      name: 'close failure after output',
      failAt: 'EventLog.close',
      expectedClosed: 0,
      expectedCode: 1,
    },
  ]
}

for (const controller of ['doctor', 'backfill'] as const) {
  it(
    'preserves original full CLI ' + controller + ' metadata and fake-action lifetime',
    async () => {
      const results = fakeActionCases(controller).map((sample, index) =>
        runProbe(cliRoot, sample, index, 'cli'),
      )
      const encoded = JSON.stringify(results, null, 2) + '\n'
      deepStrictEqual(JSON.parse(encoded), results)
      await expect(encoded).toMatchFileSnapshot('./golden/registry-ledger-' + controller + '-cli.json')
    },
    25000,
  )
  it(
    'preserves original ' + controller + ' controller order, cleanup and native exits',
    async () => {
      const results = producerCases(controller).map((sample, index) =>
        runProbe(producerRoot, sample, index, 'producer'),
      )
      const encoded = JSON.stringify(results, null, 2) + '\n'
      deepStrictEqual(JSON.parse(encoded), results)
      await expect(encoded).toMatchFileSnapshot('./golden/registry-ledger-' + controller + '-producer.json')
    },
    25000,
  )
}

it('preserves both synthetic ledger action natural pipes including assigned one', async () => {
  const results = []
  for (const controller of ['doctor', 'backfill'] as const) {
    const prefix = controller === 'doctor' ? ['doctor', 'lifecycle'] : ['lifecycle', 'backfill']
    const proofFile = path.join(cliRoot, controller + '-large.json')
    const sample = {
      controller,
      argv: prefix,
      large: true,
      ...(controller === 'backfill' ? { assigned: 1 } : {}),
    }
    const child = spawn(process.execPath, [path.join(cliRoot, 'entry.mjs')], {
      cwd: cliRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: cliRoot,
        AGENT_CHAT_HOME: path.join(cliRoot, 'home'),
        CLAUDE_CONFIG_DIR: path.join(cliRoot, 'claude'),
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: JSON.stringify(sample),
        FIXTURE_PROOF: proofFile,
      },
    })
    const stdout = createHash('sha256'),
      stderr = createHash('sha256')
    let stdoutBytes = 0,
      stderrBytes = 0,
      timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      stdout.update(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      stderr.update(chunk)
    })
    child.stdout.pause()
    child.stderr.pause()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 5000)
    setTimeout(() => {
      child.stdout.resume()
      child.stderr.resume()
    }, 100)
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      },
    )
    expect(timedOut).toBe(false)
    expect(exit).toEqual({ code: controller === 'doctor' ? 7 : 1, signal: null })
    expect(stdoutBytes).toBe(bytes)
    expect(stderrBytes).toBe(bytes + Buffer.byteLength(late))
    expect(stdout.digest('hex')).toBe(sha('O'.repeat(bytes)))
    expect(stderr.digest('hex')).toBe(sha('E'.repeat(bytes) + late))
    const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8')) as Proof
    expect(proof.events).toEqual([
      'before-cli-import',
      'after-cli-import',
      { action: controller === 'doctor' ? 'doctorLifecycle' : 'backfill', options: [] },
      { stdoutAccepted: false, stderrAccepted: false },
      'completed',
      'late',
    ])
    results.push({ controller, code: exit.code, stdoutBytes, stderrBytes, syntheticOnly: true })
  }
  console.info('LEDGER_PIPE_PROOF', JSON.stringify(results))
}, 15000)
