import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAME_CLASSES, type FrameClass } from '../broker/frame-classes.js'

const repoRoot = path.join(import.meta.dirname, '../..')

function dispatcherCases(): string[] {
  const source = fs.readFileSync(path.join(repoRoot, 'src/broker/socket.ts'), 'utf8')
  const start = source.indexOf('  handleMessage(conn: Conn, msg: ClientMessage): void {')
  const end = source.indexOf('\n  }\n', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/^ {6}case '([a-z_]+)':/gm)].map(match => match[1]!)
}

function docClasses(): Map<string, FrameClass> {
  const doc = fs.readFileSync(path.join(repoRoot, 'docs/human-caller-gate.md'), 'utf8')
  const classes = new Map<string, FrameClass>()
  let current: FrameClass | undefined
  for (const line of doc.split('\n')) {
    const heading = /^### Class ([1-4]):/.exec(line)
    if (heading) current = Number(heading[1]) as FrameClass
    else if (line.startsWith('## ')) current = undefined
    else if (current !== undefined && line.startsWith('| `')) {
      const firstColumn = line.split('|')[1]!
      for (const [, frame] of firstColumn.matchAll(/`([a-z_]+)`/g)) classes.set(frame!, current)
    }
  }
  return classes
}

describe('frame-class table', () => {
  it('has exactly one row for every case the broker dispatches', () => {
    const cases = dispatcherCases()

    expect(cases.length).toBeGreaterThan(0)
    expect(new Set(cases).size).toBe(cases.length)
    expect([...cases].sort()).toEqual(Object.keys(FRAME_CLASSES).sort())
  })

  it('matches the classes the decision record lists, frame for frame', () => {
    const documented = docClasses()

    expect(Object.fromEntries([...documented].sort())).toEqual(
      Object.fromEntries(Object.entries(FRAME_CLASSES).sort()),
    )
  })
})
