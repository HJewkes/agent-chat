import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-blocks-cli-fixture-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/command.js', 'dist/cli/verbs/seat-hook.js']) {
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  }
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const effect = path.join(dir, 'dist/cli/verbs/seat-hook.js')
  fs.renameSync(effect, effect.replace('.js', '-fixture-original.js'))
  fs.writeFileSync(
    effect,
    [
      'const fixture=globalThis.__seatBlocksFixture;',
      'if(fixture.sample.importFailure==="error")throw Error("synthetic import failure");',
      'if(fixture.sample.importFailure==="code69")throw Object.assign(Error("synthetic import unavailable"),{code:69});',
      'if(fixture.sample.importFailure==="object")throw {reason:"synthetic import",items:[1,2]};',
      'export function seatBlocks(options) {',
      ' const f=globalThis.__seatBlocksFixture;f.events.push({effect:options});',
      ' if(f.sample.failure==="error")throw Error("synthetic failure");',
      ' if(f.sample.failure==="code69")throw Object.assign(Error("synthetic unavailable"),{code:69});',
      ' if(f.sample.failure==="object")throw {reason:"synthetic",items:[1,2]};',
      ' if(f.sample.failure==="array")throw ["synthetic",2];',
      ' if(f.sample.failure==="string")throw "synthetic rejection";',
      ' if(f.sample.failure==="large-error")throw Error("e".repeat(8*1024*1024));',
      ' if(f.sample.joinFailure)return null;',
      ' if(f.sample.large==="out")return ["o".repeat(8*1024*1024)];',
      ' return f.sample.rows??["synthetic line"];',
      '}',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[];const save=fs.writeFileSync.bind(fs);',
      'globalThis.__seatBlocksFixture={sample,events};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      'process.exitCode=7;',
      "const {run}=await import('./dist/cli/index.js');",
      "try{await import('./dist/cli/verbs/seat-hook.js');}catch{}",
      "const forbidden=()=>{throw Error('unexpected fixture business IO');};",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      "for(const key of ['spawn','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
      'if(sample.stdoutFailure){const log=console.log.bind(console);let first=true;console.log=(...args)=>{if(first){first=false;throw Error("synthetic stdout failure");}return log(...args);};}',
      "setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const cases = [
  { name: 'default window natural inherited seven', argv: ['seat-blocks'], code: 7 },
  { name: 'explicit window', argv: ['seat-blocks', '--since', '90m'], code: 7 },
  { name: 'empty raw window', argv: ['seat-blocks', '--since', ''], code: 7 },
  { name: 'whitespace raw window', argv: ['seat-blocks', '--since', '  '], code: 7 },
  { name: 'repeated last window', argv: ['seat-blocks', '--since', '1h', '--since', '7d'], code: 7 },
  {
    name: 'semantic validation remains helper owned',
    argv: ['seat-blocks', '--since', 'not-a-window'],
    code: 7,
  },
  { name: 'empty array still newline', argv: ['seat-blocks'], rows: [], code: 7 },
  { name: 'joined multiple rows', argv: ['seat-blocks'], rows: ['one', 'two'], code: 7 },
  { name: 'preserve row whitespace', argv: ['seat-blocks'], rows: ['  one  ', '', 'two\\n line  '], code: 7 },
  { name: 'help hidden command', argv: ['seat-blocks', '--help'], code: 0, usage: true },
  { name: 'missing window argument', argv: ['seat-blocks', '--since'], code: 1, usage: true },
  { name: 'extra positional', argv: ['seat-blocks', 'extra'], code: 1, usage: true },
  { name: 'unknown option', argv: ['seat-blocks', '--unknown'], code: 1, usage: true },
  { name: 'Error caught natural one', argv: ['seat-blocks'], failure: 'error', code: 1 },
  { name: 'code69 caught natural one', argv: ['seat-blocks'], failure: 'code69', code: 1 },
  { name: 'object caught String rendering', argv: ['seat-blocks'], failure: 'object', code: 1 },
  { name: 'array caught String rendering', argv: ['seat-blocks'], failure: 'array', code: 1 },
  { name: 'string caught rendering', argv: ['seat-blocks'], failure: 'string', code: 1 },
  { name: 'join failure caught', argv: ['seat-blocks'], joinFailure: true, code: 1 },
  { name: 'sync stdout failure caught', argv: ['seat-blocks'], stdoutFailure: true, code: 1 },
  { name: 'import Error immediate', argv: ['seat-blocks'], importFailure: 'error', code: 1 },
  { name: 'import code69 immediate one', argv: ['seat-blocks'], importFailure: 'code69', code: 1 },
  { name: 'import object Console formatting', argv: ['seat-blocks'], importFailure: 'object', code: 1 },
  { name: 'large stdout natural inherited seven', argv: ['seat-blocks'], large: 'out', code: 7 },
  {
    name: 'large caught stderr natural assigned one',
    argv: ['seat-blocks'],
    failure: 'large-error',
    large: 'err',
    code: 1,
  },
]

it('preserves original seat-blocks caught failures, inherited success code and output lifetime', async () => {
  const results = []
  for (const [i, sample] of cases.entries()) {
    const proof = path.join(dir, 'proof-' + i + '.json')
    const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 40 * 1024 * 1024,
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
    expect(child.status, sample.name + ': ' + child.stderr).toBe(sample.code)
    const events = JSON.parse(fs.readFileSync(proof, 'utf8')) as unknown[]
    if (!sample.usage && !sample.importFailure) {
      expect(events, sample.name).toContain('completed')
      expect(events, sample.name).toContain('late')
      expect(
        events.some(event => typeof event === 'object' && event !== null && 'immediateExit' in event),
        sample.name,
      ).toBe(false)
    } else {
      expect(events, sample.name).not.toContain('completed')
      expect(events, sample.name).not.toContain('late')
    }
    const normalized = (s: string) => s.split(dir).join('/synthetic/seat-blocks-fixture')
    const output = (s: string) =>
      sample.large
        ? { bytes: Buffer.byteLength(s), sha256: createHash('sha256').update(s).digest('hex') }
        : normalized(s).split('\n')
    if (sample.large === 'out') {
      expect(child.stdout).toBe('o'.repeat(8 * 1024 * 1024) + '\n')
      expect(child.stderr).toBe('')
    }
    if (sample.large === 'err') {
      expect(child.stdout).toBe('')
      expect(child.stderr).toBe('e'.repeat(8 * 1024 * 1024) + '\n')
    }
    results.push({
      name: sample.name,
      argv: sample.argv,
      code: child.status,
      stdout: output(child.stdout),
      stderr: output(child.stderr),
      events,
    })
  }
  await expect(results).toMatchFileSnapshot('./golden/registry-seat-blocks-cli.json')
}, 30000)
