import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approveBrief, approvePortsOn } from '../agents/burndown/brief-approve.js'

const TASK = `id: CC-1
title: "t"
tags:
  - kind:x
  - brief:proposed=2026-10-09
`

describe('burndown brief approve', () => {
  let root: string
  let edits: string[][]
  const ports = () => ({
    ...approvePortsOn(root),
    edit: (_slug: string, _id: string, args: string[]) => void edits.push(args),
  })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-approve-'))
    fs.mkdirSync(path.join(root, 'init', 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(root, 'init', 'sources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'init', 'tasks', 'CC-1.yml'), TASK)
    edits = []
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('rewrites the proposed tag to brief:ready=<today> through task edit', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    const report = approveBrief('CC-1', ports(), '2026-10-10')
    expect(report.ok).toBe(true)
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('replaces a seat brief:src so the task carries one src, briefer', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:src=seat\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:src=seat'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('does not re-add brief:src=briefer when it is already the only src', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:src=briefer\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('leaves a ready seat brief with no proposal, and its src, untouched', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:ready=2026-10-01\n  - brief:src=seat\n',
    )
    expect(approveBrief('CC-1', ports(), '2026-10-10').ok).toBe(false)
    expect(edits).toEqual([])
  })

  it('removes an older brief:ready so only the new day remains', () => {
    fs.writeFileSync(path.join(root, 'init', 'sources', 'CC-1-plan.md'), 'plan')
    fs.writeFileSync(
      path.join(root, 'init', 'tasks', 'CC-1.yml'),
      'id: CC-1\ntags:\n  - brief:ready=2026-09-01\n  - brief:proposed=2026-10-09\n',
    )
    approveBrief('CC-1', ports(), '2026-10-10')
    expect(edits).toEqual([
      ['--add-tag', 'brief:ready=2026-10-10'],
      ['--add-tag', 'brief:src=briefer'],
      ['--remove-tag', 'brief:ready=2026-09-01'],
      ['--remove-tag', 'brief:proposed=2026-10-09'],
    ])
  })

  it('refuses an unknown task', () => {
    const report = approveBrief('CC-9', ports(), '2026-10-10')
    expect(report.errors?.[0]).toContain('no task CC-9')
  })

  it('refuses when no plan file exists', () => {
    const report = approveBrief('CC-1', ports(), '2026-10-10')
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toContain('no plan file')
    expect(edits).toEqual([])
  })

  it('refuses a task with no proposal', () => {
    fs.writeFileSync(path.join(root, 'init', 'tasks', 'CC-1.yml'), 'id: CC-1\ntags:\n  - kind:x\n')
    expect(approveBrief('CC-1', ports(), '2026-10-10').ok).toBe(false)
  })
})
