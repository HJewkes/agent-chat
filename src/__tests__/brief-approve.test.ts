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
      ['--remove-tag', 'brief:proposed=2026-10-09'],
      ['--add-tag', 'brief:ready=2026-10-10'],
    ])
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
