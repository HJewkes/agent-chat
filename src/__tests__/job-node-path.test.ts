import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jobNodePath } from '../mirror/node-path.js'

const VERBS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'verbs')

let prefix: string
const realExecPath = process.execPath

beforeEach(() => {
  prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'brew-'))
})

afterEach(() => {
  process.execPath = realExecPath
  fs.rmSync(prefix, { recursive: true, force: true })
})

describe('jobNodePath', () => {
  it('names the opt link, not the Cellar version, when node runs from a Homebrew Cellar', () => {
    const cellar = path.join(prefix, 'Cellar', 'node', '25.1.0', 'bin', 'node')
    const optLink = path.join(prefix, 'opt', 'node', 'bin', 'node')
    fs.mkdirSync(path.dirname(cellar), { recursive: true })
    fs.writeFileSync(cellar, '')
    fs.mkdirSync(path.dirname(optLink), { recursive: true })
    fs.symlinkSync(cellar, optLink)
    process.execPath = cellar

    expect(jobNodePath()).toBe(optLink)
  })
})

describe('install verbs', () => {
  it('take every baked-in node path from jobNodePath, so no job pins a Cellar version (CC-838)', () => {
    const verbFiles = fs.readdirSync(VERBS_DIR).filter(name => name.endsWith('.ts'))

    const pinned = verbFiles.filter(name =>
      /nodePath:\s*process\.execPath/.test(fs.readFileSync(path.join(VERBS_DIR, name), 'utf8')),
    )

    expect(pinned).toEqual([])
  })
})
