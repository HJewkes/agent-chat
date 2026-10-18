// The literal existing golden report travels through the actual copied CLI and
// actual doctor producer. Only the already-reviewed six dependencies are fakes.
import { deepStrictEqual, strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { LifecycleReport } from '../api-contract.js'
import { exactDependencyModule, decodeExactUtf8 } from './ledger-fixture-ast.js'
import { dependencyImplementations, controllerProbeEntry } from './ledger-fixture-deps.js'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
function nativeCliEntry() {
  let entry = controllerProbeEntry
  const replacements = [
    ['const module=await import(selected[0]);', "const module=await import('./dist/cli/index.js');"],
    [
      "if(typeof module[selected[1]]!=='function')throw Error('missing owned test-only action export');",
      "if(typeof module.buildProgram!=='function')throw Error('missing owned actual CLI export');",
    ],
    [
      'await module[selected[1]](sample.options??{})',
      "await module.buildProgram().exitOverride().parseAsync(['node','agent-chat','doctor','lifecycle'])",
    ],
  ] as const
  for (const [old, replacement] of replacements) {
    assert.equal(entry.split(old).length, 2, 'exact reviewed producer entry transformation')
    entry = entry.replace(old, replacement)
  }
  return entry
}
function streamLines(bytes: Buffer) {
  const text = decodeExactUtf8(bytes)
  if (text === '') return []
  assert(text.endsWith('\n'), 'the unchanged golden renderer expects complete Console lines')
  return text.slice(0, -1).split('\n')
}
export function nativeDoctorLifecycleGolden(report: LifecycleReport): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-native-golden-')))
  try {
    fs.cpSync(path.resolve('dist'), path.join(root, 'dist'), { recursive: true })
    fs.copyFileSync('package.json', path.join(root, 'package.json'))
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
    const hashes: Record<string, { original: string; copied: string }> = {}
    for (const relative of ['dist/cli/index.js', 'dist/cli/doctor-lifecycle.js', 'dist/cli/lifecycle.js']) {
      const original = fs.readFileSync(relative),
        copied = fs.readFileSync(path.join(root, relative))
      assert(original.equals(copied), 'entire actual CLI/producer module bytes unchanged')
      hashes[relative] = { original: sha(original), copied: sha(copied) }
    }
    for (const [relative, implementations] of Object.entries(dependencyImplementations)) {
      const original = fs.readFileSync(relative),
        target = path.join(root, relative)
      assert(fs.readFileSync(target).equals(original))
      assert.equal(fs.realpathSync(target), target)
      assert(fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink())
      fs.writeFileSync(target, exactDependencyModule(decodeExactUtf8(original), implementations))
    }
    const entry = path.join(root, 'entry.mjs'),
      proofPath = path.join(root, 'proof.json')
    fs.writeFileSync(entry, nativeCliEntry())
    const checked = spawnSync(process.execPath, ['--check', entry], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(checked.error, undefined)
    assert.equal(checked.signal, null)
    assert.equal(checked.status, 0, checked.stderr.toString())
    const sample = { controller: 'doctor', report }
    const encoded = JSON.stringify(sample)
    deepStrictEqual(JSON.parse(encoded), sample)
    const child = spawnSync(process.execPath, [entry], {
      cwd: root,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        HOME: root,
        AGENT_CHAT_HOME: path.join(root, 'home'),
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        NODE_ENV: 'test',
        NO_COLOR: '1',
        FIXTURE_CASE: encoded,
        FIXTURE_PROOF: proofPath,
      },
    })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.equal(child.status, 1, child.stderr.toString('hex'))
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'))
    deepStrictEqual(proof, {
      events: [
        'before-controller-import',
        'after-controller-import',
        { step: 'readMeta' },
        { step: 'readToken' },
        { step: 'fetch' },
        { fetchUrl: 'http://127.0.0.1:7600/api/lifecycle', headerKeys: [], signalAborted: false },
        { step: 'fetch.json' },
        { immediateExit: 1 },
      ],
      openCount: 0,
      closeAttempts: 0,
      closedCount: 0,
    })
    assert.equal(fs.existsSync(path.join(root, 'home', 'events.db')), false)
    console.info(
      'NATIVE_DOCTOR_GOLDEN_PROOF',
      JSON.stringify({
        hashes,
        code: child.status,
        stdoutSha256: sha(child.stdout),
        stderrSha256: sha(child.stderr),
        proof,
      }),
    )
    return [
      '=== agent-chat doctor lifecycle',
      ...streamLines(child.stdout).map(line => 'stdout: ' + line),
      ...streamLines(child.stderr).map(line => 'stderr: ' + line),
      'exit ' + child.status,
      '',
    ].join('\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
