// These entry strings replace dependency
// modules in an owned copied dist tree for the ORIGINAL-controller proof layer.
export const dependencyImplementations: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'dist/broker/event-log.js': {
    EventLog: `export class EventLog {
      constructor(file) {
        f.step('EventLog.new');
        f.events.push({openedFile:f.ownedPath(file)});
        f.log=this; f.openCount++;
      }
      ledgerHandle() { f.step('EventLog.handle'); return f.db; }
      close() { f.closeAttempts++; f.step('EventLog.close'); f.closedCount++; }
    }`,
  },
  'dist/broker/lifecycle.js': {
    probeSocket: `export async function probeSocket() {
      f.step('probeSocket'); return f.sample.socketAlive ?? false;
    }`,
    readMeta: `export function readMeta() { f.step('readMeta'); return f.sample.meta; }`,
  },
  'dist/broker/token.js': {
    readToken: `export function readToken() { f.step('readToken'); return undefined; }`,
  },
  'dist/agents/ledger/verifier.js': {
    gather: `export async function gather(options) {
      f.step('gather');
      f.events.push({gatherDbMatches:options.db===f.db,gatherLogMatches:options.events===f.log});
      return {input:f.input,shadow:f.shadow};
    }`,
    reportFrom: `export function reportFrom(input,shadow,shadowErrors,now) {
      f.step('reportFrom');
      f.events.push({inputMatches:input===f.input,shadowMatches:shadow===f.shadow,shadowErrorsIsNull:shadowErrors===null,now});
      return f.sample.report;
    }`,
  },
  'dist/agents/ledger/backfill-run.js': {
    planFromSource: `export function planFromSource(source,options) {
      f.step('planFromSource'); f.captureBackfill(source,options); return f.sample.plan;
    }`,
    runBackfill: `export function runBackfill(source,options) {
      f.step('runBackfill'); f.captureBackfill(source,options); return f.sample.backfillOutcome;
    }`,
  },
  'dist/agents/ledger/shadow-ledger.js': {
    shadowSupervisorId: `export function shadowSupervisorId() {
      f.step('shadowSupervisorId'); return 'synthetic-supervisor';
    }`,
  },
}

export const controllerProbeEntry = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import child from 'node:child_process';
import workers from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';

const sample=JSON.parse(process.env.FIXTURE_CASE);
const events=[];
const save=fs.writeFileSync.bind(fs);
const checkedJson=value=>JSON.stringify(value,(_key,item)=>{
  if(item===undefined||['bigint','function','symbol'].includes(typeof item)||
    (typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0))))
    throw Error('unrepresentable original fixture proof');
  return item;
});
const expectedFile=path.join(process.env.AGENT_CHAT_HOME,'events.db');
const forbidden=()=>{events.push({unexpectedIo:true});throw Error('unexpected ledger business IO');};
const rejected=kind=>{
  switch(kind){
    case 'error':throw Error('synthetic ledger failure');
    case 'code69':throw Object.assign(Error('synthetic unavailable'),{code:69});
    case 'object':throw {code:69,message:'synthetic object',items:[1,2]};
    case 'array':throw ['synthetic',2];
    case 'string':throw 'synthetic rejection';
    case 'number':throw 69;
    case 'null':throw null;
    case 'undefined':throw undefined;
    default:throw Error('unknown synthetic rejection shape');
  }
};
const f={
  sample,events,rejected,db:{synthetic:'db'},input:{synthetic:'input'},shadow:'on',
  now:1758600000000,openCount:0,closeAttempts:0,closedCount:0,
  step(name){events.push({step:name});if(sample.failAt===name)rejected(sample.failure??'error');},
  ownedPath(file){if(file!==expectedFile)return forbidden();return '/synthetic/ledger/events.db';},
  captureOptions(options){
    return Object.keys(options).sort().map(key=>{
      const value=options[key];
      if(value===undefined||value===null||!['string','boolean','number'].includes(typeof value)||
        (typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0))))
        throw Error('unrepresentable original action option');
      return [key,value];
    });
  },
  captureBackfill(source,options){
    const value=options.sinceDays;
    if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||Object.is(value,-0)))
      throw Error('unrepresentable original sinceDays observation');
    events.push({sourceMatches:source===f.log,fence:options.fence,
      sinceDaysOwn:Object.hasOwn(options,'sinceDays'),
      sinceDays:value===undefined?{kind:'undefined'}:{kind:'number',value}});
  },
};
globalThis.__ledgerFixture=f;
Date.now=()=>f.now;
process.exitCode=7;
process.on('exit',()=>save(process.env.FIXTURE_PROOF,checkedJson({events,openCount:f.openCount,
  closeAttempts:f.closeAttempts,closedCount:f.closedCount})));
const originalExit=process.exit.bind(process);
process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};
for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;
workers.Worker=class{constructor(){forbidden();}};
net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;
process.stdin.read=forbidden;process.stdin.resume=forbidden;process.stdin[Symbol.asyncIterator]=forbidden;
// Closed synthetic fetch only; never calls the captured/native implementation.
globalThis.fetch=async(url,options)=>{
  const port=sample.meta?.port??7600;
  if(url!=='http://127.0.0.1:'+port+'/api/lifecycle')return forbidden();
  if(Object.keys(options.headers).length!==0)return forbidden(); // readToken fake returns undefined.
  f.step('fetch');events.push({fetchUrl:url,headerKeys:[],signalAborted:options.signal.aborted});
  const status=sample.status??200;
  return {ok:status>=200&&status<300,status,json:async()=>{f.step('fetch.json');return sample.report;}};
};
syncBuiltinESMExports();
// Replaced by parent with one exact literal module URL and action name after whitelist validation.
const controllers={doctor:['./dist/cli/doctor-lifecycle.js','doctorLifecycle'],
  backfill:['./dist/cli/lifecycle.js','backfill']};
const selected=controllers[sample.controller];if(!selected)forbidden();
events.push('before-controller-import');
const module=await import(selected[0]);
events.push('after-controller-import');
if(typeof module[selected[1]]!=='function')throw Error('missing owned test-only action export');
for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','statSync','openSync'])fs[key]=forbidden;
fs.existsSync=file=>{if(file!==expectedFile)return forbidden();f.step('existsSync');return sample.fileExists??true;};
syncBuiltinESMExports();
await module[selected[1]](sample.options??{}).then(()=>events.push('completed')).catch(error=>{
  console.error(error instanceof Error?error.message:error);process.exit(1);
});
`

export const fullCliProbeEntry = String.raw`
import fs from 'node:fs';import net from 'node:net';import child from 'node:child_process';
import workers from 'node:worker_threads';import {syncBuiltinESMExports} from 'node:module';
const sample=JSON.parse(process.env.FIXTURE_CASE),events=[],save=fs.writeFileSync.bind(fs);
const checkedJson=value=>JSON.stringify(value,(_key,item)=>{
  if(item===undefined||['bigint','function','symbol'].includes(typeof item)||
    (typeof item==='number'&&(!Number.isFinite(item)||Object.is(item,-0))))
    throw Error('unrepresentable original fixture proof');
  return item;
});
const forbidden=()=>{events.push({unexpectedIo:true});throw Error('unexpected ledger business IO');};
const rejected=kind=>{switch(kind){
  case 'error':throw Error('synthetic ledger failure');
  case 'code69':throw Object.assign(Error('synthetic unavailable'),{code:69});
  case 'object':throw {code:69,message:'synthetic object',items:[1,2]};
  case 'array':throw ['synthetic',2];case 'string':throw 'synthetic rejection';
  case 'number':throw 69;case 'null':throw null;case 'undefined':throw undefined;
  default:throw Error('unknown synthetic rejection shape');
}};
const f={sample,events,rejected,captureOptions(options){return Object.keys(options).sort().map(key=>{
  const value=options[key];
  if(value===undefined||value===null||!['string','boolean','number'].includes(typeof value)||
    (typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0))))
    throw Error('unrepresentable original action option');
  return [key,value];
});}};
globalThis.__ledgerFixture=f;process.exitCode=7;
process.on('exit',()=>save(process.env.FIXTURE_PROOF,checkedJson({events})));
const originalExit=process.exit.bind(process);
process.exit=code=>{events.push({immediateExit:code});return originalExit(code);};
for(const key of ['spawn','spawnSync','exec','execFile','execSync','execFileSync'])child[key]=forbidden;
workers.Worker=class{constructor(){forbidden();}};
net.connect=forbidden;net.createConnection=forbidden;process.kill=forbidden;globalThis.fetch=forbidden;
process.stdin.read=forbidden;process.stdin.resume=forbidden;process.stdin[Symbol.asyncIterator]=forbidden;
syncBuiltinESMExports();
/* EXACT_FAKE_ACTION_INSERTION_POINT */
events.push('before-cli-import');
const {run}=await import('./dist/cli/index.js');events.push('after-cli-import');
for(const key of ['readFileSync','writeFileSync','mkdirSync','unlinkSync','readdirSync','existsSync','statSync','openSync'])fs[key]=forbidden;
syncBuiltinESMExports();
await run(['node','agent-chat',...sample.argv]).then(()=>events.push('completed')).catch(error=>{
  console.error(error instanceof Error?error.message:error);process.exit(1);
});
`

// Full-CLI layer A uses only this synthetic action body target; the original
// emitted mounts and days parser stay outside the AST replacement and byte-exact.
export const fullCliFakeAction = String.raw`
globalThis.__ledgerFixture.effect=async(name,options)=>{
  const f=globalThis.__ledgerFixture;
  const entries=f.captureOptions(options);
  f.events.push({action:name,options:entries});
  setTimeout(()=>{f.events.push('late');if(f.sample.large)process.stderr.write('late-callback\n');},0);
  if(f.sample.large){const stdoutAccepted=process.stdout.write('O'.repeat(8*1024*1024));
    const stderrAccepted=process.stderr.write('E'.repeat(8*1024*1024));f.events.push({stdoutAccepted,stderrAccepted});}
  if(f.sample.stdout)process.stdout.write(Buffer.from(f.sample.stdout));
  if(f.sample.stderr)process.stderr.write(Buffer.from(f.sample.stderr));
  if(f.sample.awaited)await new Promise(resolve=>setTimeout(()=>{f.events.push('awaited');resolve();},5));
  if(f.sample.assigned!==undefined)process.exitCode=f.sample.assigned;
  if(f.sample.immediate!==undefined)process.exit(f.sample.immediate);
  if(f.sample.failure)f.rejected(f.sample.failure);
};
`
