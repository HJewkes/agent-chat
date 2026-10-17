import { deepStrictEqual } from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-controls-cli-fixture-'))
  fs.cpSync(path.resolve('dist'), path.join(dir, 'dist'), { recursive: true })
  for (const file of ['dist/cli/index.js', 'dist/cli/command.js', 'dist/cli/service.js'])
    expect(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(file))).toBe(true)
  fs.copyFileSync('package.json', path.join(dir, 'package.json'))
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir')
  // Replace the owned copy entirely: no real service controller body is invoked or imported here.
  fs.writeFileSync(
    path.join(dir, 'dist/cli/service.js'),
    [
      'const f=globalThis.__serviceControlsFixture;',
      'async function controller(name,options){',
      'f.events.push({controller:name,options});console.log("owned "+name+" before");',
      'if(f.sample.stderrReturn)console.error("owned controller stderr");',
      'if(f.sample.awaited)await new Promise(resolve=>setTimeout(()=>{f.events.push("controller-awaited");console.log("owned "+name+" after");resolve();},5));',
      'if(f.sample.assigned)process.exitCode=9;',
      'if(f.sample.immediate){console.error("owned immediate refusal");process.exit(1);}',
      'switch(f.sample.reject){',
      'case "error":throw Error("synthetic controller failure");',
      'case "code69":throw Object.assign(Error("synthetic unavailable"),{code:69});',
      'case "object":throw {code:69,message:"synthetic object",items:[1,2]};',
      'case "array":throw ["synthetic",2];',
      'case "string":throw "synthetic rejection";',
      'case "number":throw 69;case "null":throw null;case "undefined":throw undefined;',
      '}',
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
      'const sample=JSON.parse(process.env.FIXTURE_CASE),events=[];const save=fs.writeFileSync.bind(fs);',
      'globalThis.__serviceControlsFixture={sample,events};',
      "process.on('exit',()=>save(process.env.FIXTURE_PROOF,JSON.stringify(events)));",
      'const originalExit=process.exit.bind(process);process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};',
      'process.exitCode=7;',
      "const forbidden=()=>{throw Error('unexpected service-controls business IO');};",
      "for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;",
      'net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;syncBuiltinESMExports();',
      "const {run}=await import('./dist/cli/index.js');",
      "for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;",
      'syncBuiltinESMExports();',
      "setTimeout(()=>events.push('late'),0);",
      "await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{console.error(error instanceof Error?error.message:error);process.exit(1);});",
    ].join('\n'),
  )
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

type Sample = {
  name: string
  argv: string[]
  awaited?: boolean
  assigned?: boolean
  immediate?: boolean
  stderrReturn?: boolean
  reject?: string
}
for (const verb of ['start', 'stop', 'restart']) {
  it(
    'preserves original ' + verb + ' parser, effect boundary and lifetime',
    async () => {
      const prefix = ['service', verb]
      const valueFlag = verb === 'stop' ? '--hold' : '--port'
      const values =
        verb === 'stop'
          ? [
              '1',
              '3600',
              '1e2',
              '0x10',
              '1.0',
              ' 1 ',
              '+1',
              '',
              'nope',
              '1tail',
              '0',
              '-1',
              '1.5',
              '3601',
              'Infinity',
            ]
          : [
              '1',
              '65535',
              '9023tail',
              '9024.9',
              '1e2',
              ' 9025 ',
              '+9026',
              '',
              'nope',
              '0',
              '-1',
              '65536',
              'Infinity',
            ]
      const samples: Sample[] = [
        { name: 'omitted options', argv: prefix },
        { name: 'foreground or force', argv: [...prefix, verb === 'start' ? '-f' : '--force'] },
        {
          name: 'repeat bare switch',
          argv: [...prefix, ...Array(2).fill(verb === 'start' ? '--foreground' : '--force')],
        },
        { name: 'help', argv: [...prefix, '--help'] },
        { name: 'unknown option', argv: [...prefix, '--unknown'] },
        { name: 'excess operand', argv: [...prefix, 'extra'] },
        { name: 'literal excess operand', argv: [...prefix, '--', 'extra'] },
        { name: 'missing value', argv: [...prefix, valueFlag] },
        { name: 'unknown consumed as required value', argv: [...prefix, valueFlag, '--unknown'] },
        { name: 'invalid then unknown', argv: [...prefix, valueFlag, '0', '--unknown'] },
        { name: 'unknown then invalid', argv: [...prefix, '--unknown', valueFlag, '0'] },
        { name: 'invalid then excess', argv: [...prefix, valueFlag, '0', 'extra'] },
        { name: 'excess then invalid', argv: [...prefix, 'extra', valueFlag, '0'] },
        { name: 'invalid then help', argv: [...prefix, valueFlag, '0', '--help'] },
        { name: 'help then invalid', argv: [...prefix, '--help', valueFlag, '0'] },
        { name: 'repeated values last wins', argv: [...prefix, valueFlag, '1', valueFlag, '2'] },
        { name: 'invalid repeated first', argv: [...prefix, valueFlag, '0', valueFlag, '2'] },
        { name: 'invalid repeated last', argv: [...prefix, valueFlag, '2', valueFlag, '0'] },
        {
          name: 'awaited foreground lifetime',
          argv: [...prefix, ...(verb === 'start' ? ['--foreground'] : [])],
          awaited: true,
        },
        { name: 'controller assigned exit', argv: prefix, assigned: true },
        { name: 'controller stderr natural return', argv: prefix, stderrReturn: true },
        { name: 'controller immediate exit', argv: prefix, immediate: true },
        ...values.map(value => ({
          name: 'value ' + JSON.stringify(value),
          argv: [...prefix, valueFlag + '=' + value],
        })),
        ...['error', 'code69', 'object', 'array', 'string', 'number', 'null', 'undefined'].map(reject => ({
          name: 'reject ' + reject,
          argv: prefix,
          reject,
        })),
      ]
      if (verb !== 'stop') samples.push({ name: 'short port', argv: [...prefix, '-p', '9020'] })
      if (verb !== 'start')
        samples.push({ name: 'force false is operand', argv: [...prefix, '--force', 'false'] })
      const results = []
      for (const [i, sample] of samples.entries()) {
        const proof = path.join(dir, 'proof-' + verb + '-' + i + '.json')
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
        // Every successful controller return keeps inherited status, including stderr-only output.
        if (sample.awaited) {
          expect(events, sample.name).toContain('controller-awaited')
          expect(events.indexOf('controller-awaited')).toBeLessThan(events.indexOf('completed'))
        }
        if (sample.reject || sample.immediate) {
          expect(child.status, sample.name).toBe(1)
          expect(events, sample.name).not.toContain('completed')
        }
        if (sample.assigned) expect(child.status, sample.name).toBe(9)
        results.push({
          name: sample.name,
          argv: sample.argv,
          code: child.status,
          stdout: child.stdout.split(dir).join('/synthetic/service-controls-fixture'),
          stderr: child.stderr.split(dir).join('/synthetic/service-controls-fixture'),
          events,
        })
      }
      const encoded = JSON.stringify(results, null, 2) + '\n'
      deepStrictEqual(JSON.parse(encoded), results)
      await expect(encoded).toMatchFileSnapshot('./golden/registry-service-' + verb + '-cli.json')
    },
    20000,
  )
}
