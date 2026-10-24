import childProcess, { type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { captureNextSpawn } from '../agents/launcher-signals.js'

const originalSpawn = childProcess.spawn

const exited = (child: ChildProcess): Promise<void> =>
  new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  })

const startQuietChild = (): ChildProcess => childProcess.spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })

afterEach(() => {
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
})

describe('captureNextSpawn', () => {
  /** CC-455: kills the mutation that drops restore(), which left every later spawn captured. */
  it('hands over only the first child and puts spawn back', async () => {
    const captured: ChildProcess[] = []
    captureNextSpawn(child => captured.push(child))

    const first = startQuietChild()
    const second = startQuietChild()
    await Promise.all([exited(first), exited(second)])

    expect(captured).toEqual([first])
    expect(childProcess.spawn).toBe(originalSpawn)
  })
})
