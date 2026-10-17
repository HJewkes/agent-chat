import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cli-fixture-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/command.js', 'dist/cli/watch.js']) {
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  }
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const client = path.join(dir, 'dist/cli/client.js')
  fs.renameSync(client, client.replace('.js', '-fixture-original.js'))
  fs.writeFileSync(
    client,
    [
      "export * from './client-fixture-original.js';",
      'const f=globalThis.__watchFixture;',
      'export async function withBroker(fn){f.events.push("open");try{return await fn({request:async(message,expected)=>{',
      'const i=++f.polls;f.events.push({request:message,expected});',
      'if(message.t!=="inbox_since")throw Error("unexpected fixture request");',
      'if(f.sample.stopAt===i){f.events.push("fixture-stop");process.exit(88);}',
      'if(f.sample.failAt?.includes(i)){',
      'if(f.sample.failKind==="object")throw {reason:"synthetic",items:[1,2]};',
      'if(f.sample.failKind==="array")throw ["synthetic",2];',
      'if(f.sample.failKind==="string")throw "synthetic rejection";',
      'throw Object.assign(Error("synthetic poll failure"),f.sample.failKind==="code69"?{code:69}:{});}',
      'const text=f.sample.emptyBody?" \\n\\t ":"  synthetic\\n message \\t"+i+"  ";',
      'const messages=f.sample.empty?[]:f.sample.multiple?[{msgId:i*10+1,from:"one",text:"first\\n line"},{msgId:i*10+2,from:"two",text:"broadcast\\tsecond",broadcast:true}]:[{msgId:i,from:"worker",text,broadcast:f.sample.broadcast===true}];',
      'return {t:"inbox_since_result",messages,nextCursor:40+i};',
      '}});}finally{f.events.push("close");}}',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[];const save=fs.writeFileSync.bind(fs);',
      'globalThis.__watchFixture={sample,events,polls:0};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      'process.exitCode=7;',
      "const {run}=await import('./dist/cli/index.js');",
      "const forbidden=()=>{throw Error('unexpected watch business IO');};",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      "for(const key of ['spawn','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
      'const realTimeout=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>{if(ms>=100){events.push({sleep:ms});return realTimeout(fn,1,...args);}return realTimeout(fn,ms,...args);};',
      "setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const cases = [
  { name: 'default now once skips backlog', argv: ['watch', 'synthetic', '--once'], code: 7 },
  { name: 'all once starts zero', argv: ['watch', 'synthetic', '--since', 'all', '--once'], code: 7 },
  { name: 'explicit cursor', argv: ['watch', 'synthetic', '--since', '12', '--once'], code: 7 },
  { name: 'hex cursor Number semantics', argv: ['watch', 'synthetic', '--since', '0x10', '--once'], code: 7 },
  { name: 'empty cursor is zero', argv: ['watch', 'synthetic', '--since', '', '--once'], code: 7 },
  { name: 'whitespace cursor is zero', argv: ['watch', 'synthetic', '--since', '  ', '--once'], code: 7 },
  {
    name: 'repeated cursor last wins',
    argv: ['watch', 'synthetic', '--since', '12', '--since', '14', '--once'],
    code: 7,
  },
  {
    name: 'fractional interval accepted',
    argv: ['watch', 'synthetic', '--interval', '0.2', '--once'],
    code: 7,
  },
  { name: 'hex interval accepted', argv: ['watch', 'synthetic', '--interval', '0x10', '--once'], code: 7 },
  { name: 'empty name preserved', argv: ['watch', '', '--once'], code: 7 },
  { name: 'whitespace name preserved', argv: ['watch', '  ', '--once'], code: 7 },
  { name: 'empty inbox prints nothing', argv: ['watch', 'synthetic', '--once'], empty: true, code: 7 },
  {
    name: 'multiple and broadcast rows',
    argv: ['watch', 'synthetic', '--since', 'all', '--once'],
    multiple: true,
    code: 7,
  },
  {
    name: 'empty body keeps exact line',
    argv: ['watch', 'synthetic', '--once'],
    emptyBody: true,
    broadcast: true,
    code: 7,
  },
  { name: 'invalid since fractional', argv: ['watch', 'synthetic', '--since', '1.5', '--once'], code: 1 },
  { name: 'invalid since negative', argv: ['watch', 'synthetic', '--since=-1', '--once'], code: 1 },
  {
    name: 'invalid interval zero before initial poll',
    argv: ['watch', 'synthetic', '--interval', '0', '--once'],
    code: 1,
  },
  { name: 'invalid interval empty', argv: ['watch', 'synthetic', '--interval', '', '--once'], code: 1 },
  {
    name: 'invalid interval infinity',
    argv: ['watch', 'synthetic', '--interval', 'Infinity', '--once'],
    code: 1,
  },
  { name: 'missing name', argv: ['watch'], code: 1 },
  { name: 'missing since argument', argv: ['watch', 'synthetic', '--since'], code: 1 },
  { name: 'extra positional', argv: ['watch', 'synthetic', 'extra'], code: 1 },
  { name: 'unknown option', argv: ['watch', 'synthetic', '--unknown'], code: 1 },
  { name: 'help', argv: ['watch', '--help'], code: 0 },
  { name: 'initial now failure is fatal', argv: ['watch', 'synthetic', '--once'], failAt: [1], code: 1 },
  { name: 'once later failure is fatal', argv: ['watch', 'synthetic', '--once'], failAt: [2], code: 1 },
  {
    name: 'once code69 remains one',
    argv: ['watch', 'synthetic', '--once'],
    failAt: [2],
    failKind: 'code69',
    code: 1,
  },
  {
    name: 'once raw object failure',
    argv: ['watch', 'synthetic', '--since', 'all', '--once'],
    failAt: [1],
    failKind: 'object',
    code: 1,
  },
  {
    name: 'once raw array failure',
    argv: ['watch', 'synthetic', '--since', 'all', '--once'],
    failAt: [1],
    failKind: 'array',
    code: 1,
  },
  {
    name: 'once raw string failure',
    argv: ['watch', 'synthetic', '--since', 'all', '--once'],
    failAt: [1],
    failKind: 'string',
    code: 1,
  },
  {
    name: 'follow later failure retries same cursor',
    argv: ['watch', 'synthetic'],
    failAt: [2],
    stopAt: 4,
    code: 88,
  },
  {
    name: 'follow repeated failures retain cursor',
    argv: ['watch', 'synthetic'],
    failAt: [2, 3],
    stopAt: 4,
    code: 88,
  },
  {
    name: 'follow all can recover first loop failure',
    argv: ['watch', 'synthetic', '--since', 'all', '--interval', '0.25'],
    failAt: [1],
    stopAt: 4,
    code: 88,
  },
  {
    name: 'follow initial now failure remains fatal',
    argv: ['watch', 'synthetic'],
    failAt: [1],
    stopAt: 4,
    code: 1,
  },
]
it('preserves actual watch loop, CLI defaults, cursor/rendering/retry and natural lifetime', async () => {
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
    expect(events.includes('completed'), sample.name).toBe(sample.code === 7)
    expect(events.includes('late'), sample.name).toBe(sample.code === 7 || sample.code === 88)
    // Splitting retains every byte on join, including terminal newline and trailing spaces.
    const lines = (s: string) => s.split(dir).join('/synthetic/watch-fixture').split('\n')
    results.push({
      name: sample.name,
      argv: sample.argv,
      code: child.status,
      stdoutLines: lines(child.stdout),
      stderrLines: lines(child.stderr),
      events,
    })
  }
  await expect(results).toMatchFileSnapshot('./golden/registry-watch-cli.json')
}, 30000)
