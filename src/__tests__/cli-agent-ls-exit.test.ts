import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ls-real-exit-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/agents.js', 'dist/cli/command.js']) {
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  }
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  const shim = (file: string, body: string) => {
    const original = file.replace(/\.js$/, '-fixture-original.js')
    fs.renameSync(path.join(dir, file), path.join(dir, original))
    fs.writeFileSync(
      path.join(dir, file),
      "export * from './" + path.basename(original) + "';\nconst f=globalThis.__agentLsFixture;\n" + body,
    )
  }
  shim(
    'dist/cli/client.js',
    [
      'export async function withBroker(fn) {',
      " f.events.push('open');try {",
      " if(f.sample.brokerFailure) throw Object.assign(new Error('synthetic unavailable'),{code:69});",
      ' return await fn({request:async message=>{f.events.push(message.t);',
      " if(message.t==='agents') return {t:'agents_result',agents:f.sample.populated?[f.agent]:[]};",
      " if(message.t==='list') return {t:'list_result',sessions:f.sample.connected===false?[]:[{name:'worker'}]};",
      " if(message.t==='reported'){if(f.sample.reportFailure) throw Error('synthetic report unavailable');return {t:'reported_result',reported:true};}",
      " throw Error('unexpected request '+message.t);}});",
      " } finally {f.events.push('close');}}",
    ].join('\n'),
  )
  shim(
    'dist/agents/transcript.js',
    [
      "export const createProfileIndex=()=>{f.events.push('index');return {};};",
      "export const findAgentTranscript=()=>{f.events.push('transcript');return {path:'/synthetic/transcript',exists:false};};",
      "export const observedModel=()=>{f.events.push('model');if(f.sample.modelFailure)throw Error('synthetic model failure');return 'synthetic-model';};",
      "export const transcriptLine=()=>{f.events.push('transcriptLine');return 'transcript: synthetic';};",
    ].join('\n'),
  )
  shim(
    'dist/agents/budget.js',
    "export const readBudget=()=>{f.events.push('budget');if(f.sample.budgetFailure)throw Error('synthetic budget failure');return {found:false};};",
  )
  shim('dist/agents/retire-due.js', 'export const contextKOf=()=>f.sample.past?120:null;')
  shim(
    'dist/config.js',
    [
      "export const retireThresholdK=()=>{f.events.push('threshold');return 80;};",
      "export const loadResolvedConfig=()=>{f.events.push('config');return {tick:{}};};",
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(dir, 'entry.mjs'),
    [
      "import fs from 'node:fs';",
      "import net from 'node:net';",
      "import child from 'node:child_process';",
      "import {syncBuiltinESMExports} from 'node:module';",
      'const sample=JSON.parse(process.env.FIXTURE_CASE);',
      'const events=[];const save=fs.writeFileSync.bind(fs);',
      "const agent={agentId:'id-one',name:'worker',profile:'implementer',state:'live',origin:'spawned',spawnedBy:'boss',spawnedAt:1,brief:'synthetic',cwd:'/synthetic/worker',isolation:'none',surface:'headless',sessionId:'synthetic-session',lastEventAt:2,generation:1};",
      'globalThis.__agentLsFixture={sample,events,agent};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'Date.now=()=>1700000000000;',
      "const {run}=await import('./dist/cli/index.js');",
      "const forbidden=()=>{throw Error('unexpected business IO');};",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      "for(const key of ['spawn','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;',
      'syncBuiltinESMExports();',
      "if(sample.late)setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const cases = [
  { name: 'bare empty', argv: ['agent'], code: 0, late: true },
  { name: 'explicit empty JSON', argv: ['agent', 'ls', '--json'], code: 0 },
  { name: 'actual early format refusal', argv: ['agent', 'ls', '--format', 'bad'], code: 1 },
  { name: 'actual early state refusal', argv: ['agent', 'ls', '--state', 'sleeping'], code: 1 },
  { name: 'actual mine caller refusal', argv: ['agent', '--mine'], code: 1 },
  {
    name: 'explicit spawner overrides mine',
    argv: ['agent', '--mine', '--spawner', 'boss', '--format', 'line'],
    populated: true,
    code: 0,
  },
  {
    name: 'populated line skips readings',
    argv: ['agent', 'ls', '--format', 'line'],
    populated: true,
    past: true,
    code: 0,
  },
  {
    name: 'JSON plus line keeps JSON but skips readings',
    argv: ['agent', '--json', '--format', 'line'],
    populated: true,
    past: true,
    code: 0,
  },
  { name: 'default populated text', argv: ['agent'], populated: true, code: 0 },
  {
    name: 'past threshold optional second scope',
    argv: ['agent', 'ls', '--json'],
    populated: true,
    past: true,
    code: 0,
  },
  {
    name: 'reported error degrades',
    argv: ['agent', '--json'],
    populated: true,
    past: true,
    reportFailure: true,
    code: 0,
  },
  {
    name: 'budget error degrades',
    argv: ['agent', 'ls', '--json'],
    populated: true,
    budgetFailure: true,
    code: 0,
  },
  {
    name: 'model error degrades',
    argv: ['agent', '--json', '--format', 'line'],
    populated: true,
    modelFailure: true,
    code: 0,
  },
  { name: 'broker69 remains one', argv: ['agent'], brokerFailure: true, code: 1 },
  { name: 'unknown actual preflight', argv: ['agent', 'unknown', '--help'], code: 1 },
]
it('preserves real process exits, original listing effects and fake IO ordering', async () => {
  const results = []
  for (const [i, sample] of cases.entries()) {
    const proof = path.join(dir, 'proof-' + i + '.json')
    const child = spawnSync(process.execPath, [path.join(dir, 'entry.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        HOME: dir,
        AGENT_CHAT_HOME: dir,
        AGENT_CHAT_NO_AUTOSTART: '1',
        CLAUDE_CONFIG_DIR: dir,
        CLAUDE_PROFILE_ROOT: dir,
        FIXTURE_CASE: JSON.stringify(sample),
        FIXTURE_PROOF: proof,
      },
    })
    expect(child.error, sample.name).toBeUndefined()
    expect(child.signal, sample.name).toBeNull()
    expect(child.status, sample.name + ': ' + child.stderr).toBe(sample.code)
    expect(child.stderr, sample.name).not.toContain('unexpected business IO')
    const events: string[] = JSON.parse(fs.readFileSync(proof, 'utf8'))
    // Only this owned scratch root varies; keep every command/output byte otherwise.
    const stable = (text: string) => text.replaceAll(dir, '/synthetic/agent-ls-fixture')
    results.push({
      name: sample.name,
      stdout: stable(child.stdout),
      stderr: stable(child.stderr),
      code: child.status,
      events,
    })
  }
  await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot(
    './golden/registry-agent-ls-real-exits.json',
  )
}, 15_000)
