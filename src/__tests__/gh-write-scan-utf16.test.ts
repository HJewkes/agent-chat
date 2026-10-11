import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGh, runGhWrite } from '../cli/gh-write.js'
import { utf8Body } from '../gh-write/body-text.js'
import { scanDeps, scanGhArgs, SCAN_REASONS } from '../gh-write/scan.js'
import type { ThrottleDeps } from '../gh-write/throttle.js'

// Synthetic only: a made-up private term.
const TERM = 'zq7privateseat'
const BODY = `Summary line.\nThis body names ${TERM} in the middle.\n`

const utf16le = (text: string): Buffer => Buffer.from(text, 'utf16le')
const utf16be = (text: string): Buffer => utf16le(text).swap16()
const withBom = (bom: number[], bytes: Buffer): Buffer => Buffer.concat([Buffer.from(bom), bytes])

const ENCODINGS: [string, Buffer][] = [
  ['UTF-16 LE with BOM', withBom([0xff, 0xfe], utf16le(BODY))],
  ['UTF-16 BE with BOM', withBom([0xfe, 0xff], utf16be(BODY))],
  ['UTF-16 LE without BOM', utf16le(BODY)],
]

let dir: string
let savedPath: string | undefined
const file = (name: string): string => path.join(dir, name)
const calls = (): string => file('calls')
const bodies = (): string => file('bodies')
const ghStarted = (): boolean => fs.existsSync(calls())

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ghw-utf16-'))
  fs.mkdirSync(file('bin'))
  fs.writeFileSync(file('terms'), `${TERM}\n`)
  // A fake gh that logs its arguments and copies out every file gh-write handed it.
  fs.writeFileSync(
    file('bin/gh'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${calls()}"`,
      `for a in "$@"; do f=\${a##*[=@]}; case "$f" in */gh-write-*/source-*) cat "$f" >> "${bodies()}";; esac; done`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  savedPath = process.env.PATH
  process.env.PATH = `${file('bin')}:${process.env.PATH}`
})

afterEach(() => {
  process.env.PATH = savedPath
  fs.rmSync(dir, { recursive: true, force: true })
})

const throttle = (): ThrottleDeps => ({
  now: Date.now,
  sleep: ms => realSleep(ms),
  runGh,
  coreRemaining: () => Promise.resolve(undefined),
  notice: () => undefined,
  lockDir: file('lock'),
  stampPath: file('stamp'),
  gapMs: 0,
})

describe('gh-write scan of a UTF-16 body', () => {
  it.each(ENCODINGS)('refuses pr create --body-file in %s', async (_name, bytes) => {
    fs.writeFileSync(file('b.md'), bytes)

    const scan = await scanGhArgs(
      ['pr', 'create', '-t', 'x', '--body-file', file('b.md')],
      scanDeps(file('terms')),
    )

    expect(scan).toEqual({ reason: SCAN_REASONS.notUtf8 })
  })

  it.each(ENCODINGS)('refuses gh api -F body=@file in %s', async (_name, bytes) => {
    fs.writeFileSync(file('b.md'), bytes)

    const scan = await scanGhArgs(
      ['api', 'repos/o/r/issues/1/comments', '-F', `body=@${file('b.md')}`],
      scanDeps(file('terms')),
    )

    expect(scan).toEqual({ reason: SCAN_REASONS.notUtf8 })
  })

  it.each(ENCODINGS)('refuses --body-file - with %s on stdin', async (_name, bytes) => {
    const deps = { ...scanDeps(file('terms')), readStdin: () => Promise.resolve(utf8Body(bytes)) }

    const scan = await scanGhArgs(['pr', 'comment', '1', '--body-file', '-'], deps)

    expect(scan).toEqual({ reason: SCAN_REASONS.notUtf8 })
  })

  it.each(ENCODINGS)('never starts gh for a %s body', async (_name, bytes) => {
    fs.writeFileSync(file('b.md'), bytes)

    const result = await runGhWrite(
      ['pr', 'create', '-t', 'x', '--body-file', file('b.md')],
      scanDeps(file('terms')),
      throttle(),
    )

    expect(result.code).toBe(1)
    expect(result.stderr.toString()).toBe(`${SCAN_REASONS.notUtf8}\n`)
    expect(ghStarted()).toBe(false)
  })

  it('posts a clean UTF-8 body with non-ASCII text byte for byte', async () => {
    const clean = 'Résumé of the change: naïve “quotes”, emoji 🚀, and 日本語.\n'
    fs.writeFileSync(file('b.md'), clean)

    const result = await runGhWrite(
      ['pr', 'create', '-t', 'x', '--body-file', file('b.md')],
      scanDeps(file('terms')),
      throttle(),
    )

    expect(result.code).toBe(0)
    expect(fs.readFileSync(bodies())).toEqual(Buffer.from(clean, 'utf8'))
  })
})
