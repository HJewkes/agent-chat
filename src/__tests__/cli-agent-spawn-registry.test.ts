import { deepStrictEqual } from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
const bytes = 8 * 1024 * 1024
const late = 'late-callback\n'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-cli-fixture-')))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const name of ['dist/cli/index.js', 'dist/cli/agents.js', 'dist/cli/command.js'])
    expect(fs.readFileSync(path.join(dir, name)).equals(fs.readFileSync(name))).toBe(true)
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const original = fs.readFileSync('dist/cli/agents.js', 'utf8')
  const surface = original.match(/export function parseSurface\(value\) \{[\s\S]*?\n\}/)?.[0]
  const spawnedAs = original.match(/export function parseSpawnedAs\(value\) \{[\s\S]*?\n\}/)?.[0]
  const choices = original.match(/const SPAWNED_AS = [^\n]+/)?.[0]
  expect(surface).toBeDefined()
  expect(spawnedAs).toBeDefined()
  expect(choices).toBeDefined()
  const exports = [...original.matchAll(/^export (?:async )?function ([\w]+)/gm)].map(match => match[1]!)
  expect(exports).toContain('agentSpawn')
  fs.writeFileSync(
    path.join(dir, 'dist/cli/agents.js'),
    [
      "import { InvalidArgumentError } from 'commander';import { SURFACE_NAMES } from '../protocol.js';",
      'const f=globalThis.__spawnFixture;',
      'f.events.push("agents-import");',
      choices,
      surface,
      spawnedAs,
      'const forbidden=()=>{throw Error("unexpected real agents effect");};',
      ...exports
        .filter(name => !['agentSpawn', 'parseSurface', 'parseSpawnedAs'].includes(name))
        .map(name => 'export const ' + name + '=forbidden;'),
      'function rejected(kind){switch(kind){case "error":throw Error("synthetic spawn failure");case "code69":throw Object.assign(Error("synthetic unavailable"),{code:69});',
      'case "object":throw {code:69,message:"synthetic object",items:[1,2]};case "array":throw ["synthetic",2];case "string":throw "synthetic rejection";case "number":throw 69;case "null":throw null;case "undefined":throw undefined;}}',
      'export async function agentSpawn(name,profile,words,options){',
      'const entries=Object.keys(options).sort().map(key=>[key,options[key]]);',
      'f.events.push({effect:"agentSpawn",name,profile,words,options:entries});',
      'setTimeout(()=>{f.events.push("late");if(f.sample.large)process.stderr.write("late-callback\\n");},0);',
      'if(f.sample.large){const stdoutAccepted=process.stdout.write("O".repeat(' +
        bytes +
        '));const stderrAccepted=process.stderr.write("E".repeat(' +
        bytes +
        '));f.events.push({stdoutAccepted,stderrAccepted});}',
      'if(f.sample.out!==undefined)process.stdout.write(f.sample.out);',
      'if(f.sample.stderr)process.stderr.write("synthetic spawn diagnostic\\n");',
      'if(f.sample.awaited)await new Promise(resolve=>setTimeout(()=>{f.events.push("awaited");resolve();},5));',
      'if(f.sample.assigned)process.exitCode=9;',
      'if(f.sample.immediate!==undefined)process.exit(f.sample.immediate);',
      'if(f.sample.failure)rejected(f.sample.failure);',
      '}',
    ].join('\n'),
  )
  const fake = path.join(dir, 'dist/cli/agents.js')
  expect(fs.lstatSync(fake).isFile()).toBe(true)
  expect(fs.lstatSync(fake).isSymbolicLink()).toBe(false)
  expect(fs.realpathSync(fake)).toBe(fake)
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import workers from 'node:worker_threads';",
      "import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[],save=fs.writeFileSync.bind(fs);',
      'globalThis.__spawnFixture={sample,events};process.exitCode=7;',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      "const forbidden=()=>{throw Error('unexpected spawn business IO');};",
      "for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'workers.Worker=class{constructor(){forbidden();}};',
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;',
      'process.stdin.read=forbidden;process.stdin.resume=forbidden;process.stdin[Symbol.asyncIterator]=forbidden;',
      'syncBuiltinESMExports();',
      "const {run}=await import('./dist/cli/index.js');",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      'syncBuiltinESMExports();',
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

type Sample = {
  name: string
  argv: string[]
  out?: string
  stderr?: boolean
  awaited?: boolean
  assigned?: boolean
  immediate?: number
  failure?: string
}

it('preserves original spawn argv, native parsers, raw options, errors and lifetime', async () => {
  const base = ['agent', 'spawn', 'synthetic-name', 'synthetic-profile']
  const samples: Sample[] = [
    { name: 'absent brief and options', argv: base },
    { name: 'one word', argv: [...base, 'brief'] },
    { name: 'words and spaces', argv: [...base, 'one', ' two ', '', '\t'] },
    { name: 'raw empty name and profile', argv: ['agent', 'spawn', '', '', 'brief'] },
    { name: 'raw whitespace name and profile', argv: ['agent', 'spawn', ' name ', '\t', 'brief'] },
    { name: 'dash brief after delimiter', argv: [...base, '--', '--literal', '-x'] },
    { name: 'brief stdin omitted brief', argv: [...base, '--brief-stdin'] },
    { name: 'brief stdin with words', argv: [...base, 'brief', '--brief-stdin'] },
    { name: 'remote control', argv: [...base, '--remote-control'] },
    {
      name: 'all raw options',
      argv: [
        ...base,
        'brief',
        '--briefing',
        'auto',
        '--brief-stdin',
        '--config-dir',
        '/synthetic/account',
        '--task',
        'TP-synthetic',
        '--role',
        'reviewer',
        '--surface',
        'headless',
        '--spawned-as',
        'shepherd',
        '--remote-control',
        '--host',
        'synthetic-host',
      ],
    },
    ...[
      ['briefing', ' slug '],
      ['config-dir', ''],
      ['task', ' task '],
      ['role', 'other'],
      ['host', ' host '],
    ].map(([key, value]) => ({ name: 'raw ' + key, argv: [...base, '--' + key!, value!] })),
    { name: 'surface iterm', argv: [...base, '--surface', 'iterm-pane'] },
    { name: 'spawned as burndown', argv: [...base, '--spawned-as', 'burndown'] },
    { name: 'repeated string', argv: [...base, '--host', 'first', '--host', 'second'] },
    {
      name: 'repeated switches',
      argv: [...base, '--brief-stdin', '--brief-stdin', '--remote-control', '--remote-control'],
    },
    {
      name: 'repeated parser valid',
      argv: [
        ...base,
        '--surface',
        'headless',
        '--surface',
        'iterm-pane',
        '--spawned-as',
        'shepherd',
        '--spawned-as',
        'burndown',
      ],
    },
    { name: 'surface invalid', argv: [...base, '--surface', 'synthetic-invalid'] },
    { name: 'surface whitespace', argv: [...base, '--surface', ' headless '] },
    { name: 'spawned as invalid', argv: [...base, '--spawned-as', 'synthetic-invalid'] },
    { name: 'surface invalid then unknown', argv: [...base, '--surface', 'bad', '--unknown'] },
    { name: 'unknown then surface invalid', argv: [...base, '--unknown', '--surface', 'bad'] },
    { name: 'spawned as invalid then unknown', argv: [...base, '--spawned-as', 'bad', '--unknown'] },
    { name: 'unknown then spawned as invalid', argv: [...base, '--unknown', '--spawned-as', 'bad'] },
    {
      name: 'valid then invalid repeated parser',
      argv: [...base, '--surface', 'headless', '--surface', 'bad'],
    },
    {
      name: 'invalid then valid repeated parser',
      argv: [...base, '--surface', 'bad', '--surface', 'headless'],
    },
    { name: 'missing required both', argv: ['agent', 'spawn'] },
    { name: 'missing profile', argv: ['agent', 'spawn', 'name'] },
    { name: 'missing value before unknown', argv: [...base, '--host', '--unknown'] },
    { name: 'missing parser value', argv: [...base, '--surface'] },
    { name: 'help', argv: ['agent', 'spawn', '--help'] },
    { name: 'unknown option', argv: [...base, '--unknown'] },
    { name: 'awaited', argv: base, awaited: true, out: 'owned output\n' },
    { name: 'assigned code', argv: base, assigned: true },
    { name: 'immediate success', argv: base, immediate: 0 },
    { name: 'immediate failure', argv: base, immediate: 1, out: 'owned partial\n' },
    { name: 'natural stdout stderr', argv: base, out: 'owned output without newline', stderr: true },
    ...['error', 'code69', 'object', 'array', 'string', 'number', 'null', 'undefined'].map(failure => ({
      name: 'rejected ' + failure,
      argv: base,
      failure,
      out: 'owned partial\n',
    })),
  ]
  const results = []
  for (const [i, sample] of samples.entries()) {
    const proof = path.join(dir, 'case-' + i + '.json')
    const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: dir,
        AGENT_CHAT_HOME: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: JSON.stringify(sample),
        FIXTURE_PROOF: proof,
      },
    })
    expect(child.error, sample.name).toBeUndefined()
    expect(child.signal, sample.name).toBeNull()
    const events = JSON.parse(fs.readFileSync(proof, 'utf8')) as unknown[]
    expect(events[0], sample.name).toBe('agents-import')
    if (sample.failure) {
      expect(child.status, sample.name).toBe(1)
      expect(events, sample.name).not.toContain('completed')
    }
    if (sample.assigned) expect(child.status).toBe(9)
    if (sample.immediate !== undefined) expect(child.status).toBe(sample.immediate)
    if (sample.awaited) expect(events.indexOf('awaited')).toBeLessThan(events.indexOf('completed'))
    results.push({
      name: sample.name,
      argv: sample.argv,
      code: child.status,
      stdout: child.stdout.split(dir).join('/synthetic/spawn-fixture'),
      stderr: child.stderr.split(dir).join('/synthetic/spawn-fixture'),
      events,
    })
  }
  const encoded = JSON.stringify(results, null, 2) + '\n'
  deepStrictEqual(JSON.parse(encoded), results)
  await expect(encoded).toMatchFileSnapshot('./golden/registry-agent-spawn-cli.json')
}, 25000)

it('preserves spawn adapter natural fake-controller return through large pipes', async () => {
  const proof = path.join(dir, 'large.json')
  const child = spawn(process.execPath, [path.join(dir, 'entry.mjs')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: dir,
      AGENT_CHAT_HOME: path.join(dir, 'home'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      NODE_ENV: 'test',
      NO_COLOR: '1',
      FIXTURE_CASE: JSON.stringify({
        argv: ['agent', 'spawn', 'synthetic-name', 'synthetic-profile'],
        large: true,
      }),
      FIXTURE_PROOF: proof,
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
  expect(exit).toEqual({ code: 7, signal: null })
  expect(stdoutBytes).toBe(bytes)
  expect(stderrBytes).toBe(bytes + Buffer.byteLength(late))
  expect(stdout.digest('hex')).toBe(hash('O'.repeat(bytes)))
  expect(stderr.digest('hex')).toBe(hash('E'.repeat(bytes) + late))
  expect(JSON.parse(fs.readFileSync(proof, 'utf8'))).toEqual([
    'agents-import',
    { effect: 'agentSpawn', name: 'synthetic-name', profile: 'synthetic-profile', words: [], options: [] },
    { stdoutAccepted: false, stderrAccepted: false },
    'completed',
    'late',
  ])
  console.info(
    'SPAWN_PIPE_PROOF',
    JSON.stringify({ code: exit.code, stdoutBytes, stderrBytes, naturalFakeControllerOnly: true }),
  )
}, 15000)
