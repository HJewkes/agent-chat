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
const controllers = { 'gh-write': 'ghWriteCommand', 'suite-slot': 'suiteSlotCommand' } as const

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-cli-fixture-')))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const name of [
    'dist/cli/index.js',
    'dist/cli/command.js',
    'dist/cli/gh-write.js',
    'dist/cli/suite-slot.js',
  ])
    expect(fs.readFileSync(path.join(dir, name)).equals(fs.readFileSync(name))).toBe(true)
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  fs.writeFileSync(
    path.join(dir, 'dist/cli/wrapper-fixture-effect.js'),
    [
      'const f=globalThis.__wrapperFixture;',
      'export function imported(name){f.events.push({import:name});}',
      'export const forbidden=()=>{throw Error("unexpected real wrapper export");};',
      'function rejected(kind){switch(kind){case "error":throw Error("synthetic wrapper failure");case "code69":throw Object.assign(Error("synthetic unavailable"),{code:69});',
      'case "object":throw {code:69,message:"synthetic object",items:[1,2]};case "array":throw ["synthetic",2];case "string":throw "synthetic rejection";case "number":throw 69;case "null":throw null;case "undefined":throw undefined;}}',
      'export async function effect(name,argv){f.events.push({effect:name,argv});',
      'setTimeout(()=>{f.events.push("late");if(f.sample.large)process.stderr.write("late-callback\\n");},0);',
      'if(f.sample.large){const stdoutAccepted=process.stdout.write("O".repeat(' +
        bytes +
        '));const stderrAccepted=process.stderr.write("E".repeat(' +
        bytes +
        '));f.events.push({stdoutAccepted,stderrAccepted});}',
      'if(f.sample.stdout)process.stdout.write(Buffer.from(f.sample.stdout));',
      'if(f.sample.stderr)process.stderr.write(Buffer.from(f.sample.stderr));',
      'if(f.sample.awaited)await new Promise(resolve=>setTimeout(()=>{f.events.push("awaited");resolve();},5));',
      'if(f.sample.assigned!==undefined)process.exitCode=f.sample.assigned;',
      'if(f.sample.immediate!==undefined)process.exit(f.sample.immediate);',
      'if(f.sample.failure)rejected(f.sample.failure);',
      '}',
    ].join('\n'),
  )
  for (const [name, controller] of Object.entries(controllers)) {
    const original = fs.readFileSync('dist/cli/' + name + '.js', 'utf8')
    const exports = [...original.matchAll(/^export (?:async )?(?:function|const) ([\w]+)/gm)].map(
      match => match[1]!,
    )
    expect(exports).toContain(controller)
    fs.writeFileSync(
      path.join(dir, 'dist/cli/' + name + '.js'),
      [
        "import {effect,imported,forbidden} from './wrapper-fixture-effect.js';",
        'imported(' + JSON.stringify(name) + ');',
        'export const ' + controller + '=async argv=>effect(' + JSON.stringify(name) + ',argv);',
        ...exports.filter(item => item !== controller).map(item => 'export const ' + item + '=forbidden;'),
      ].join('\n'),
    )
  }
  const pinnedModules = ['gh-write.js', 'suite-slot.js', 'wrapper-fixture-effect.js'].map(name => {
    const file = path.join(dir, 'dist/cli', name)
    expect(fs.lstatSync(file).isFile()).toBe(true)
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
    expect(fs.realpathSync(file)).toBe(file)
    return [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
  })
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import workers from 'node:worker_threads';",
      "import {syncBuiltinESMExports} from 'node:module';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';",
      'const readPinned=fs.readFileSync.bind(fs),statPinned=fs.lstatSync.bind(fs),openPinned=fs.openSync.bind(fs),fstatPinned=fs.fstatSync.bind(fs),closePinned=fs.closeSync.bind(fs);',
      'const pinnedModules=new Map(' + JSON.stringify(pinnedModules) + ');',
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[],save=fs.writeFileSync.bind(fs);',
      'globalThis.__wrapperFixture={sample,events};process.exitCode=7;',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      "const forbidden=()=>{throw Error('unexpected wrapper business IO');};",
      "for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'workers.Worker=class{constructor(){forbidden();}};',
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;',
      'process.stdin.read=forbidden;process.stdin.resume=forbidden;process.stdin[Symbol.asyncIterator]=forbidden;',
      'syncBuiltinESMExports();',
      "const {run}=await import('./dist/cli/index.js');",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      'fs.readFileSync=(file,...args)=>{',
      'let local;try{local=file instanceof URL?fileURLToPath(file):file;}catch{return forbidden();}',
      'if(typeof local!=="string"||!pinnedModules.has(local))return forbidden();',
      'if(args.length>1||(args[0]!==undefined&&args[0]!=="utf8"&&args[0]!=="utf-8"))return forbidden();',
      'const meta=statPinned(local);if(!meta.isFile()||meta.isSymbolicLink())return forbidden();',
      'const fd=openPinned(local,"r");try{',
      'const opened=fstatPinned(fd);if(!opened.isFile()||opened.dev!==meta.dev||opened.ino!==meta.ino)return forbidden();',
      'const data=readPinned(fd);if(createHash("sha256").update(data).digest("hex")!==pinnedModules.get(local))return forbidden();',
      'return args[0]===undefined?data:data.toString("utf8");',
      '}finally{closePinned(fd);}',
      '};',
      'syncBuiltinESMExports();',
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

type Sample = {
  name: string
  argv: string[]
  stdout?: number[]
  stderr?: number[]
  awaited?: boolean
  assigned?: number
  immediate?: number
  failure?: string
}
for (const command of ['gh-write', 'suite-slot'] as const) {
  it(
    'preserves original ' + command + ' raw argv, bytes, imports, codes and lifetime',
    async () => {
      const base = [command, '--', 'synthetic-bin']
      const binary = [0, 255, 192, 128, 13, 10, 65]
      const samples: Sample[] = [
        { name: 'missing argv', argv: [command] },
        { name: 'empty delimiter', argv: [command, '--'] },
        { name: 'one value', argv: [command, 'synthetic-bin'] },
        { name: 'empty value', argv: [command, ''] },
        { name: 'raw words', argv: [command, 'one', ' two ', '', '\t', 'λ'] },
        { name: 'raw flags after delimiter', argv: [...base, '--opaque', '-x', '--', 'tail'] },
        { name: 'literal help after delimiter', argv: [...base, '--help'] },
        {
          name: 'repeated raw values',
          argv: [...base, 'same', 'same', '--flag', 'first', '--flag', 'second'],
        },
        { name: 'help', argv: [command, '--help'] },
        { name: 'unknown option', argv: [command, '--unknown'] },
        { name: 'unknown after value without delimiter', argv: [command, 'synthetic-bin', '--unknown'] },
        { name: 'binary stdout', argv: base, stdout: binary },
        { name: 'binary stderr', argv: base, stderr: binary },
        { name: 'binary both', argv: base, stdout: binary, stderr: [66, 13, 10, 0, 254] },
        { name: 'no final newline', argv: base, stdout: [65, 66], stderr: [67, 68] },
        { name: 'awaited', argv: base, awaited: true, stdout: [65, 10] },
        ...[0, 1, 69, 127].map(assigned => ({ name: 'assigned ' + assigned, argv: base, assigned })),
        { name: 'immediate success', argv: base, immediate: 0 },
        { name: 'immediate failure', argv: base, immediate: 1 },
        ...['error', 'code69', 'object', 'array', 'string', 'number', 'null', 'undefined'].map(failure => ({
          name: 'rejected ' + failure,
          argv: base,
          failure,
          stdout: [112, 97, 114, 116, 105, 97, 108, 0, 255],
        })),
      ]
      const results = []
      for (const [i, sample] of samples.entries()) {
        const proof = path.join(dir, command + '-' + i + '.json')
        const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
          cwd: dir,
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
        if (sample.failure) {
          expect(child.status, sample.name).toBe(1)
          expect(events, sample.name).not.toContain('completed')
        }
        if (sample.assigned !== undefined) expect(child.status, sample.name).toBe(sample.assigned)
        if (sample.immediate !== undefined) expect(child.status, sample.name).toBe(sample.immediate)
        if (sample.awaited) expect(events.indexOf('awaited')).toBeLessThan(events.indexOf('completed'))
        if (sample.stdout)
          expect(child.stdout.subarray(0, sample.stdout.length)).toEqual(Buffer.from(sample.stdout))
        if (sample.stderr)
          expect(child.stderr.subarray(0, sample.stderr.length)).toEqual(Buffer.from(sample.stderr))
        results.push({
          name: sample.name,
          argv: sample.argv,
          code: child.status,
          stdoutHex: child.stdout.toString('hex'),
          stderrHex: child.stderr.toString('hex'),
          events,
        })
      }
      const encoded = JSON.stringify(results, null, 2) + '\n'
      deepStrictEqual(JSON.parse(encoded), results)
      await expect(encoded).toMatchFileSnapshot('./golden/registry-' + command + '-cli.json')
    },
    25000,
  )
}

it('preserves both raw-wrapper natural fake-controller returns through large pipes', async () => {
  const results = []
  for (const command of ['gh-write', 'suite-slot']) {
    const proof = path.join(dir, command + '-large.json')
    const child = spawn(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: dir,
        AGENT_CHAT_HOME: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: JSON.stringify({ argv: [command, '--', 'synthetic-bin'], large: true }),
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
    const imports =
      command === 'gh-write' ? [{ import: 'suite-slot' }, { import: 'gh-write' }] : [{ import: 'suite-slot' }]
    expect(JSON.parse(fs.readFileSync(proof, 'utf8'))).toEqual([
      ...imports,
      { effect: command, argv: ['synthetic-bin'] },
      { stdoutAccepted: false, stderrAccepted: false },
      'completed',
      'late',
    ])
    results.push({ command, code: exit.code, stdoutBytes, stderrBytes, naturalFakeControllerOnly: true })
  }
  console.info('WRAPPER_PIPE_PROOF', JSON.stringify(results))
}, 15000)
