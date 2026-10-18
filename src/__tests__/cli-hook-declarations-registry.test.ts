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
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cli-fixture-')))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of [
    'dist/cli/index.js',
    'dist/cli/command.js',
    'dist/cli/verbs/seat-hook.js',
    'dist/cli/verbs/leak-pretool.js',
  ])
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  fs.writeFileSync(
    path.join(dir, 'dist/cli/verbs/hook-fixture-effect.js'),
    [
      'const f=globalThis.__hookFixture;',
      'function rejected(kind){switch(kind){case "error":throw Error("synthetic hook failure");case "code69":throw Object.assign(Error("synthetic unavailable"),{code:69});',
      'case "object":throw {code:69,message:"synthetic object",items:[1,2]};case "array":throw ["synthetic",2];case "string":throw "synthetic rejection";case "number":throw 69;case "null":throw null;case "undefined":throw undefined;}}',
      'export function checkImport(name){f.events.push({import:name});if(f.sample.importFailure)rejected(f.sample.importFailure);}',
      'export async function effect(name,args){f.events.push({effect:name,args});',
      'setTimeout(()=>{f.events.push("late");if(f.sample.large)process.stderr.write("late-callback\\n");},0);',
      'if(f.sample.large){const stdoutAccepted=process.stdout.write("O".repeat(' +
        bytes +
        '));const stderrAccepted=process.stderr.write("E".repeat(' +
        bytes +
        '));f.events.push({stdoutAccepted,stderrAccepted});}',
      'if(f.sample.out!==undefined)process.stdout.write(f.sample.out);',
      'if(f.sample.stderr)process.stderr.write("synthetic hook diagnostic\\n");',
      'if(f.sample.awaited)await new Promise(resolve=>setTimeout(()=>{f.events.push("awaited");resolve();},5));',
      'if(f.sample.assigned)process.exitCode=9;',
      'if(f.sample.immediate)process.exit(1);',
      'if(f.sample.failure)rejected(f.sample.failure);',
      '}',
      'export const forbidden=()=>{throw Error("unexpected real hook export");};',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'dist/cli/verbs/seat-hook.js'),
    [
      "import {effect,checkImport,forbidden} from './hook-fixture-effect.js';",
      'checkImport("seat-hook");',
      'export const seatHook=async phase=>effect("seat-hook",[phase]);',
      'export const seatBlocks=forbidden;',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'dist/cli/verbs/leak-pretool.js'),
    [
      "import {effect,checkImport,forbidden} from './hook-fixture-effect.js';",
      'checkImport("leak-pretool");',
      'export const leakPretool=async()=>effect("leak-pretool",[]);',
      'export const decidePretool=forbidden,DECISION_DEADLINE_MS=12000;',
    ].join('\n'),
  )
  const pinnedModules = ['seat-hook.js', 'leak-pretool.js', 'hook-fixture-effect.js'].map(name => {
    const file = path.join(dir, 'dist/cli/verbs', name)
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(file).isFile()).toBe(true)
    expect(fs.realpathSync(file)).toBe(file)
    return [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
  })
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import workers from 'node:worker_threads';",
      "import {syncBuiltinESMExports} from 'node:module';",
      "import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';",
      'const readPinned=fs.readFileSync.bind(fs),statPinned=fs.lstatSync.bind(fs),openPinned=fs.openSync.bind(fs),fstatPinned=fs.fstatSync.bind(fs),closePinned=fs.closeSync.bind(fs);',
      'const pinnedModules=new Map(' + JSON.stringify(pinnedModules) + ');',

      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[],save=fs.writeFileSync.bind(fs);',
      'globalThis.__hookFixture={sample,events};process.exitCode=7;',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      "const forbidden=()=>{throw Error('unexpected hook business IO');};",
      "for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'workers.Worker=class{constructor(){forbidden();}};',
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
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
  out?: string
  awaited?: boolean
  assigned?: boolean
  immediate?: boolean
  stderr?: boolean
  failure?: string
  importFailure?: string
}
const deny = '{"synthetic":"deny"}\n'
for (const hook of ['seat-hook', 'leak-pretool']) {
  it(
    'preserves original ' + hook + ' raw argv, imports, effects and lifetime',
    async () => {
      const prefix = hook === 'seat-hook' ? ['seat-hook', 'pre'] : ['leak-guard', 'pretool']
      const samples: Sample[] = [
        { name: 'zero output', argv: prefix },
        { name: 'exact deny JSON newline', argv: prefix, out: deny },
        { name: 'awaited output', argv: prefix, out: deny, awaited: true },
        { name: 'assigned code', argv: prefix, assigned: true },
        { name: 'natural stderr', argv: prefix, stderr: true },
        { name: 'immediate effect exit', argv: prefix, immediate: true },
        { name: 'help', argv: [...prefix.slice(0, hook === 'seat-hook' ? 1 : 2), '--help'] },
        { name: 'unknown option', argv: [...prefix, '--unknown'] },
        { name: 'excess operand', argv: [...prefix, 'extra'] },
        ...['error', 'code69', 'object', 'array', 'string', 'number', 'null', 'undefined'].flatMap(
          failure => [
            { name: 'effect ' + failure, argv: prefix, failure, out: 'owned partial\n' },
            { name: 'import ' + failure, argv: prefix, importFailure: failure },
          ],
        ),
      ]
      if (hook === 'seat-hook') {
        for (const phase of ['pre', 'post', 'end', 'unknown', '', ' pre ', '\t', '--literal'])
          samples.push({ name: 'phase ' + JSON.stringify(phase), argv: ['seat-hook', '--', phase] })
        samples.push({ name: 'missing phase', argv: ['seat-hook'] })
      } else {
        samples.push(
          { name: 'parent help', argv: ['leak-guard', '--help'] },
          { name: 'parent only', argv: ['leak-guard'] },
        )
      }
      const results = []
      for (const [i, sample] of samples.entries()) {
        const proof = path.join(dir, hook + '-' + i + '.json')
        const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 5000,
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
        if (sample.failure || sample.importFailure || sample.immediate) {
          expect(child.status, sample.name).toBe(1)
          expect(events, sample.name).not.toContain('completed')
        }
        if (sample.assigned) expect(child.status).toBe(9)
        if (sample.awaited) expect(events.indexOf('awaited')).toBeLessThan(events.indexOf('completed'))
        results.push({
          name: sample.name,
          argv: sample.argv,
          code: child.status,
          stdout: child.stdout.split(dir).join('/synthetic/hook-fixture'),
          stderr: child.stderr.split(dir).join('/synthetic/hook-fixture'),
          events,
        })
      }
      const encoded = JSON.stringify(results, null, 2) + '\n'
      deepStrictEqual(JSON.parse(encoded), results)
      await expect(encoded).toMatchFileSnapshot('./golden/registry-' + hook + '-cli.json')
    },
    20000,
  )
}

it('drains each hook natural return through both large backpressured pipes', async () => {
  const results = []
  for (const hook of ['seat-hook', 'leak-pretool']) {
    const argv = hook === 'seat-hook' ? ['seat-hook', 'pre'] : ['leak-guard', 'pretool']
    const proof = path.join(dir, hook + '-pipe.json')
    const child = spawn(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: dir,
        AGENT_CHAT_HOME: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: JSON.stringify({ argv, large: true }),
        FIXTURE_PROOF: proof,
      },
    })
    const outHash = createHash('sha256'),
      errHash = createHash('sha256')
    let stdoutBytes = 0,
      stderrBytes = 0
    child.stdout.pause()
    child.stderr.pause()
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      outHash.update(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      errHash.update(chunk)
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
    expect(stdoutBytes).toBe(bytes)
    expect(stderrBytes).toBe(bytes + Buffer.byteLength(late))
    const stdout = outHash.digest('hex'),
      stderr = errHash.digest('hex')
    expect(stdout).toBe(hash('O'.repeat(bytes)))
    expect(stderr).toBe(hash('E'.repeat(bytes) + late))
    const events = JSON.parse(fs.readFileSync(proof, 'utf8')) as unknown[]
    expect(events).toEqual([
      { import: hook },
      { effect: hook, args: hook === 'seat-hook' ? ['pre'] : [] },
      { stdoutAccepted: false, stderrAccepted: false },
      'completed',
      'late',
    ])
    results.push({ hook, ...exit, stdoutBytes, stderrBytes, stdout, stderr, events })
  }
  console.info('HOOK_PIPE_PROOF ' + JSON.stringify(results))
}, 20000)
