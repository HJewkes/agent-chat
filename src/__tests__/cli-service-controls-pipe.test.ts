import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import ts from 'typescript'
import { afterAll, beforeAll, expect, it } from 'vitest'

const base = '5b133ef8c894483ae9e19899d250f95f455d3446'
const bytes = 8 * 1024 * 1024
const late = 'late-callback\n'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
let root: string
let originalIndex: string
let candidateIndex: Buffer
let sourceHash: string
const dirs = new Map<string, string>()
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-controls-pipe-'))
  const source = execFileSync('git', ['show', base + ':src/cli/index.ts'], { encoding: 'utf8' })
  expect(source.split('\n')[2]).toBe("import './warnings.js'")
  sourceHash = hash(source)
  originalIndex = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName: 'index.ts',
  }).outputText
  expect(originalIndex).toContain('.action(service.start)')
  expect(originalIndex).not.toContain('serviceStartVerb')
  candidateIndex = fs.readFileSync('dist/cli/index.js')
  expect(candidateIndex.toString()).toContain('serviceStartVerb')
  for (const phase of ['original', 'candidate']) {
    const dir = path.join(root, phase)
    dirs.set(phase, dir)
    fs.mkdirSync(dir)
    fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
    for (const name of ['dist/cli/index.js', 'dist/cli/service.js', 'dist/cli/command.js'])
      expect(fs.readFileSync(path.join(dir, name)).equals(fs.readFileSync(name))).toBe(true)
    fs.copyFileSync('package.json', path.join(dir, 'package.json'))
    fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
    if (phase === 'original') fs.writeFileSync(path.join(dir, 'dist/cli/index.js'), originalIndex)
    expect(
      fs
        .readFileSync(path.join(dir, 'dist/cli/index.js'))
        .equals(phase === 'original' ? Buffer.from(originalIndex) : candidateIndex),
    ).toBe(true)
    fs.writeFileSync(
      path.join(dir, 'dist/cli/service.js'),
      [
        'const f=globalThis.__servicePipeFixture;',
        'async function controller(name,options){',
        'f.events.push({controller:name,options});',
        'const stdoutAccepted=process.stdout.write("O".repeat(' + bytes + '));',
        'const stderrAccepted=process.stderr.write("E".repeat(' + bytes + '));',
        'f.events.push({stdoutAccepted,stderrAccepted});',
        'setTimeout(()=>{f.events.push("late");process.stderr.write("late-callback\\n");},0);',
        '}',
        'export const start=async options=>controller("start",options);',
        'export const stop=async options=>controller("stop",options);',
        'export const restart=async options=>controller("restart",options);',
        'const forbidden=()=>{throw Error("unexpected real service path");};',
        'export const open=forbidden,collectStatus=forbidden,tailLines=forbidden;',
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      [
        "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';",
        "import {syncBuiltinESMExports} from 'node:module';",
        'const events=[],save=fs.writeFileSync.bind(fs);globalThis.__servicePipeFixture={events};',
        "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
        'process.exitCode=7;',
        "const forbidden=()=>{throw Error('unexpected service-pipe business IO');};",
        "for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
        'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
        "const {run}=await import('./dist/cli/index.js');",
        "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
        'syncBuiltinESMExports();',
        "await run(['node','agent-chat','service',process.env.FIXTURE_VERB]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
      ].join('\n'),
    )
  }
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

it('drains each original and registered service natural return through backpressured stdout AND stderr', async () => {
  const results = []
  const expectedOut = hash('O'.repeat(bytes))
  const expectedErr = hash('E'.repeat(bytes) + late)
  for (const phase of ['original', 'candidate']) {
    const dir = dirs.get(phase)
    if (!dir) throw Error('missing owned fixture')
    for (const verb of ['start', 'stop', 'restart']) {
      const proof = path.join(dir, verb + '-proof.json')
      const child = spawn(process.execPath, [path.join(dir, 'entry.mjs')], {
        cwd: dir,
        env: {
          HOME: dir,
          AGENT_CHAT_HOME: path.join(dir, 'home'),
          CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
          NODE_ENV: 'test',
          NO_COLOR: '1',
          FIXTURE_VERB: verb,
          FIXTURE_PROOF: proof,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdoutBytes = 0,
        stderrBytes = 0
      const stdoutHash = createHash('sha256'),
        stderrHash = createHash('sha256')
      child.stdout.pause()
      child.stderr.pause()
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        stdoutHash.update(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        stderrHash.update(chunk)
      })
      const resume = setTimeout(() => {
        child.stdout.resume()
        child.stderr.resume()
      }, 100)
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 5000)
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        },
      ).finally(() => {
        clearTimeout(resume)
        clearTimeout(timeout)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      })
      expect(timedOut).toBe(false)
      expect(exit).toEqual({ code: 7, signal: null })
      const stdout = stdoutHash.digest('hex'),
        stderr = stderrHash.digest('hex')
      expect(stdoutBytes).toBe(bytes)
      expect(stderrBytes).toBe(bytes + Buffer.byteLength(late))
      expect(stdout).toBe(expectedOut)
      expect(stderr).toBe(expectedErr)
      const events = JSON.parse(fs.readFileSync(proof, 'utf8')) as unknown[]
      expect(events).toEqual([
        { controller: verb, options: {} },
        { stdoutAccepted: false, stderrAccepted: false },
        'completed',
        'late',
      ])
      results.push({ phase, verb, ...exit, stdoutBytes, stderrBytes, stdout, stderr, events })
    }
  }
  console.info(
    'SERVICE_PIPE_PROOF ' +
      JSON.stringify({
        base,
        sourceHash,
        originalEmittedHash: hash(originalIndex),
        candidateEmittedHash: hash(candidateIndex),
        results,
      }),
  )
}, 20000)
