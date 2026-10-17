import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-open-cli-fixture-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/command.js', 'dist/cli/service.js']) {
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  }
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const lifecycle = path.join(dir, 'dist/broker/lifecycle.js')
  fs.renameSync(lifecycle, lifecycle.replace('.js', '-fixture-original.js'))
  fs.writeFileSync(
    lifecycle,
    [
      "export * from './lifecycle-fixture-original.js';",
      'const f=globalThis.__serviceOpenFixture;',
      'export const readMeta=()=>{f.events.push("readMeta");',
      'if(f.sample.metaFailure==="error")throw Error("synthetic metadata failure");',
      'if(f.sample.metaFailure==="code69")throw Object.assign(Error("synthetic unavailable"),{code:69});',
      'if(f.sample.metaFailure==="object")throw {reason:"synthetic",items:[1,2]};',
      'if(f.sample.metaFailure==="array")throw ["synthetic",2];',
      'if(f.sample.metaFailure==="string")throw "synthetic rejection";',
      'return f.sample.metaAbsent?null:{port:f.sample.metaNull?null:f.sample.metaPort??9011};};',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';",
      "import {EventEmitter} from 'node:events';import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[];const save=fs.writeFileSync.bind(fs);',
      'globalThis.__serviceOpenFixture={sample,events};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      'process.exitCode=7;',
      "const forbidden=()=>{throw Error('unexpected service-open business IO');};",
      'child.spawn=(file,args,options)=>{events.push({spawn:{file,args,options}});',
      'if(sample.spawnFailure==="error")throw Error("synthetic opener failure");',
      'if(sample.spawnFailure==="code69")throw Object.assign(Error("synthetic opener unavailable"),{code:69});',
      'const emitter=new EventEmitter();emitter.unref=()=>{events.push("unref");return emitter;};',
      'if(sample.openerError)setTimeout(()=>{events.push("opener-error");emitter.emit("error",Error("synthetic asynchronous opener error"));},5);',
      'return emitter;};',
      "for(const key of ['exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'syncBuiltinESMExports();',
      "const {run}=await import('./dist/cli/index.js');",
      'Object.defineProperty(process.stdout,"isTTY",{value:sample.tty===true});',
      'Object.defineProperty(process,"platform",{value:sample.platform??"darwin"});',
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
      "setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const cases = [
  { name: 'nonTTY metadata', argv: ['service', 'open'], code: 7 },
  { name: 'nonTTY default without metadata', argv: ['service', 'open'], metaAbsent: true, code: 7 },
  { name: 'null metadata port falls back', argv: ['service', 'open'], metaNull: true, code: 7 },
  { name: 'zero metadata port is retained', argv: ['service', 'open'], metaPort: 0, code: 7 },
  {
    name: 'explicit port skips failed metadata',
    argv: ['service', 'open', '-p', '9022'],
    metaFailure: 'error',
    code: 7,
  },
  { name: 'TTY darwin unrefs opener', argv: ['service', 'open'], tty: true, code: 7 },
  { name: 'TTY linux uses xdg', argv: ['service', 'open'], tty: true, platform: 'linux', code: 7 },
  { name: 'TTY other platform uses xdg', argv: ['service', 'open'], tty: true, platform: 'win32', code: 7 },
  {
    name: 'asynchronous opener failure prints second URL',
    argv: ['service', 'open'],
    tty: true,
    openerError: true,
    code: 7,
  },
  { name: 'trailing port text parseInt', argv: ['service', 'open', '--port=9023tail'], code: 7 },
  { name: 'fractional port parseInt', argv: ['service', 'open', '-p', '9024.9'], code: 7 },
  { name: 'exponent port parseInt', argv: ['service', 'open', '-p', '1e2'], code: 7 },
  { name: 'whitespace port parseInt', argv: ['service', 'open', '-p', ' 9025 '], code: 7 },
  { name: 'repeated port last wins', argv: ['service', 'open', '-p', '9000', '--port', '9001'], code: 7 },
  { name: 'highest accepted port', argv: ['service', 'open', '-p', '65535'], code: 7 },
  { name: 'bad zero port', argv: ['service', 'open', '-p', '0'], code: 1, immediate: true },
  { name: 'bad high port', argv: ['service', 'open', '-p', '65536'], code: 1, immediate: true },
  { name: 'bad empty port', argv: ['service', 'open', '--port='], code: 1, immediate: true },
  { name: 'bad text port', argv: ['service', 'open', '-p', 'nope'], code: 1, immediate: true },
  { name: 'missing port value', argv: ['service', 'open', '-p'], code: 1, immediate: true },
  { name: 'unknown option', argv: ['service', 'open', '--unknown'], code: 1, immediate: true },
  { name: 'excess positional', argv: ['service', 'open', 'extra'], code: 1, immediate: true },
  { name: 'help', argv: ['service', 'open', '--help'], code: 0, immediate: true },
  { name: 'metadata Error', argv: ['service', 'open'], metaFailure: 'error', code: 1, immediate: true },
  {
    name: 'metadata code69 remains one',
    argv: ['service', 'open'],
    metaFailure: 'code69',
    code: 1,
    immediate: true,
  },
  { name: 'metadata raw object', argv: ['service', 'open'], metaFailure: 'object', code: 1, immediate: true },
  { name: 'metadata raw array', argv: ['service', 'open'], metaFailure: 'array', code: 1, immediate: true },
  { name: 'metadata raw string', argv: ['service', 'open'], metaFailure: 'string', code: 1, immediate: true },
  {
    name: 'synchronous opener Error',
    argv: ['service', 'open'],
    tty: true,
    spawnFailure: 'error',
    code: 1,
    immediate: true,
  },
  {
    name: 'synchronous opener code69 remains one',
    argv: ['service', 'open'],
    tty: true,
    spawnFailure: 'code69',
    code: 1,
    immediate: true,
  },
]
it('preserves actual open effect, parser, callback ordering and natural inherited status', async () => {
  const results = []
  for (const [i, sample] of cases.entries()) {
    const proof = path.join(dir, 'proof-' + i + '.json')
    const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        HOME: dir,
        AGENT_CHAT_HOME: path.join(dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
        AGENT_CHAT_PORT: '8765',
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: JSON.stringify(sample),
        FIXTURE_PROOF: proof,
      },
    })
    expect(child.error, sample.name).toBeUndefined()
    expect(child.signal, sample.name).toBeNull()
    expect(child.status, sample.name + ': ' + child.stderr).toBe(sample.code)
    const events = JSON.parse(fs.readFileSync(proof, 'utf8')) as unknown[]
    expect(events.includes('completed'), sample.name).toBe(!sample.immediate)
    expect(events.includes('late'), sample.name).toBe(!sample.immediate)
    results.push({
      name: sample.name,
      argv: sample.argv,
      code: child.status,
      stdout: child.stdout.split(dir).join('/synthetic/service-open-fixture'),
      stderr: child.stderr.split(dir).join('/synthetic/service-open-fixture'),
      events,
    })
  }
  await expect(results).toMatchFileSnapshot('./golden/registry-service-open-cli.json')
}, 20000)
