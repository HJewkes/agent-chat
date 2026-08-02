import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as kernel from '../spawn-kernel.js'

/**
 * Guards the one thing about `agent-chat/spawn-kernel` that a consumer in
 * another repo cannot guard for us: that the subpath in `exports` still points
 * at a file that exists, and at SOURCE rather than at `dist/`.
 *
 * `dist/` is gitignored. If this entry is ever "tidied" to `./dist/
 * spawn-kernel.js`, every test in this repo keeps passing — `pretest` builds
 * `dist/` first — while a fresh clone of the consumer breaks with a module it
 * cannot resolve and no obvious reason why. That asymmetry is the whole reason
 * the subpath is written the way it is, so it gets an assertion rather than a
 * comment.
 */

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

const exportsMap = (): Record<string, string> => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>
  }
  return pkg.exports ?? {}
}

describe('the spawn-kernel subpath', () => {
  it('is declared in package.json exports', () => {
    expect(exportsMap()['./spawn-kernel']).toBeDefined()
  })

  it('points at TypeScript source, not the gitignored build output', () => {
    const target = exportsMap()['./spawn-kernel'] ?? ''
    expect(target).toMatch(/^\.\/src\/.*\.ts$/)
    expect(target).not.toContain('dist')
  })

  it('points at a file that exists', () => {
    const target = exportsMap()['./spawn-kernel'] ?? ''
    expect(fs.existsSync(path.join(root, target))).toBe(true)
  })

  it('re-exports both modules relay imports', () => {
    // Named individually rather than snapshotted: the point is that removing
    // one breaks here, in the repo that owns it, instead of in relay's daemon.
    expect(typeof kernel.findTranscript).toBe('function')
    expect(typeof kernel.transcriptPath).toBe('function')
    expect(typeof kernel.projectSlug).toBe('function')
    expect(typeof kernel.readTail).toBe('function')
    expect(typeof kernel.observedModel).toBe('function')
    expect(typeof kernel.transcriptLine).toBe('function')
    expect(typeof kernel.findDenials).toBe('function')
  })

  it('builds a resume-with-message argv without starting anything', () => {
    // R-59: the shape verified against the installed CLI. `-p/--print` is a
    // boolean there, so the message rides as the positional prompt after it.
    expect(kernel.resumeWithMessage('sess-1', 'the build is green')).toEqual({
      bin: 'claude',
      args: ['-p', '--', 'the build is green', '--resume', 'sess-1'],
    })
  })

  it('guards a message starting with "-" behind "--", matching launch-plan.ts', () => {
    expect(kernel.resumeWithMessage('sess-1', '-1 on that approach')).toEqual({
      bin: 'claude',
      args: ['-p', '--', '-1 on that approach', '--resume', 'sess-1'],
    })
  })

  it('refuses the two empties that fail as a hang rather than an error', () => {
    // An empty id resumes the most recent conversation on the machine, since
    // `--resume` takes an optional value; an empty message leaves -p on stdin.
    expect(() => kernel.resumeWithMessage('', 'hi')).toThrow(/session id/)
    expect(() => kernel.resumeWithMessage('sess-1', '  ')).toThrow(/message/)
  })

  it('exports nothing that spawns a process', () => {
    // run-agent.ts builds `env: { ...process.env }`, which relay's own threat
    // model (T7/M8) forbids outright. Keeping it out is a property of this
    // module, so it is asserted rather than left to review.
    expect(Object.keys(kernel).some(name => /spawn|launch|runAgent/i.test(name))).toBe(false)
  })
})
