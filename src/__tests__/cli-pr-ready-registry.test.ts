import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-cli-fixture-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/command.js', 'dist/cli/verbs/pr-ready.js']) {
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  }
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const effect = path.join(dir, 'dist/cli/verbs/pr-ready.js')
  fs.renameSync(effect, effect.replace('.js', '-fixture-original.js'))
  fs.writeFileSync(
    effect,
    [
      'const fixture=globalThis.__prReadyFixture;',
      'if(fixture.sample.failure==="import-error")throw Error("synthetic import failure");',
      'if(fixture.sample.failure==="import-object")throw {reason:"synthetic import",items:[1,2]};',
      'export async function prReady(options) {',
      ' const f=globalThis.__prReadyFixture;f.events.push({effect:Object.fromEntries(Object.entries(options).sort(([a],[b])=>a.localeCompare(b)))});',
      " if(f.sample.failure==='error')throw Error('synthetic failure');",
      " if(f.sample.failure==='code69')throw Object.assign(Error('synthetic unavailable'),{code:69});",
      " if(f.sample.failure==='object')throw {reason:'synthetic',items:[1,2]};",
      " if(f.sample.failure==='array')throw ['synthetic',2];",
      " if(f.sample.failure==='string')throw 'synthetic rejection';",
      " process.stdout.write(f.sample.large?'o'.repeat(8*1024*1024)+'\\n':'synthetic stdout\\n');",
      " process.stderr.write(f.sample.large?'e'.repeat(8*1024*1024)+'\\n':'synthetic stderr\\n');",
      ' return f.sample.code??0;',
      '}',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[];const save=fs.writeFileSync.bind(fs);',
      'globalThis.__prReadyFixture={sample,events};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      'process.exitCode=7;',
      "const {run}=await import('./dist/cli/index.js');",
      "try{await import('./dist/cli/verbs/pr-ready.js');}catch{}",
      "const forbidden=()=>{throw Error('unexpected fixture business IO');};",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      "for(const key of ['spawn','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
      "setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const cases = [
  { name: 'default rebase true and reset inherited code', argv: ['pr-ready'], code: 0 },
  { name: 'failed completion returns naturally', argv: ['pr-ready'], code: 1 },
  { name: 'no rebase', argv: ['pr-ready', '--no-rebase'], code: 0 },
  { name: 'strict', argv: ['pr-ready', '--strict'], code: 1 },
  {
    name: 'all options',
    argv: ['pr-ready', '--title', 'raw title', '--body-file', 'synthetic.md', '--no-rebase', '--strict'],
    code: 0,
  },
  { name: 'empty strings', argv: ['pr-ready', '--title', '', '--body-file', ''], code: 0 },
  { name: 'whitespace strings', argv: ['pr-ready', '--title', '  ', '--body-file', '  '], code: 0 },
  { name: 'repeated last title', argv: ['pr-ready', '--title', 'one', '--title', 'two'], code: 0 },
  { name: 'repeated last file', argv: ['pr-ready', '--body-file', 'one', '--body-file', 'two'], code: 0 },
  { name: 'repeated no rebase', argv: ['pr-ready', '--no-rebase', '--no-rebase'], code: 0 },
  { name: 'repeated strict', argv: ['pr-ready', '--strict', '--strict'], code: 0 },
  { name: 'help', argv: ['pr-ready', '--help'], code: 0, usage: true },
  { name: 'missing title', argv: ['pr-ready', '--title'], code: 1, usage: true },
  { name: 'missing body file', argv: ['pr-ready', '--body-file'], code: 1, usage: true },
  { name: 'excess positional', argv: ['pr-ready', 'extra'], code: 1, usage: true },
  { name: 'unknown option', argv: ['pr-ready', '--unknown'], code: 1, usage: true },
  { name: 'unrecognized positive rebase', argv: ['pr-ready', '--rebase'], code: 1, usage: true },
  { name: 'Error immediate one', argv: ['pr-ready'], failure: 'error', code: 1 },
  { name: 'code69 immediate one', argv: ['pr-ready'], failure: 'code69', code: 1 },
  { name: 'raw object immediate one', argv: ['pr-ready'], failure: 'object', code: 1 },
  { name: 'raw array immediate one', argv: ['pr-ready'], failure: 'array', code: 1 },
  { name: 'raw string immediate one', argv: ['pr-ready'], failure: 'string', code: 1 },
  { name: 'import Error immediate one', argv: ['pr-ready'], failure: 'import-error', code: 1 },
  { name: 'import object immediate one', argv: ['pr-ready'], failure: 'import-object', code: 1 },
  { name: 'success large stdout stderr pipe', argv: ['pr-ready'], code: 0, large: true },
  { name: 'failure large stdout stderr pipe', argv: ['pr-ready'], code: 1, large: true },
]

it('preserves original pr-ready CLI raw options, completion codes, exceptions and pipe lifetime', async () => {
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
    if (!sample.usage && !sample.failure) {
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
    const normalized = (s: string) => s.split(dir).join('/synthetic/pr-ready-fixture')
    const output = (s: string) =>
      sample.large
        ? { bytes: Buffer.byteLength(s), sha256: createHash('sha256').update(s).digest('hex') }
        : normalized(s).split('\n')
    if (sample.large) {
      expect(child.stdout).toBe('o'.repeat(8 * 1024 * 1024) + '\n')
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
  await expect(results).toMatchFileSnapshot('./golden/registry-pr-ready-cli.json')
}, 30000)
