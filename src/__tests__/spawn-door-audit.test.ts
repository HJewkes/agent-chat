import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { audit, report, type DoorRecord } from '../../scripts/spawn-door-audit.mjs'

const REPO = path.resolve(import.meta.dirname, '../..')
const dirs: string[] = []

const door = (p: string, kind: string): DoorRecord => ({
  path: p,
  kind,
  why: 'fixture',
  owner: 'owner',
  coordinatorSideDoor: false,
})

function tree(files: Record<string, string>, doors: DoorRecord[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-door-'))
  dirs.push(root)
  for (const [rel, body] of Object.entries({
    ...files,
    'audit/spawn-doors.json': JSON.stringify({ doors }),
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), body)
  }
  return root
}

const SENDER = "export const f = { t: 'spawn', name: 'x' }\n"
const RESUME = "export const f = { t: 'resume' as const, name: 'x' }\n"
const LAUNCH = "const r = resolveClaudeBin({})\nexecFileSync('claude', [])\n"
const HANDLER = 'class B {\n  private async handleSpawn(c: unknown) {}\n}\n'

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('spawn door audit', () => {
  it('finds each kind of door in a fixture tree', () => {
    const root = tree({ 'src/a.ts': SENDER, 'src/b.ts': RESUME, 'src/c.ts': LAUNCH, 'src/d.ts': HANDLER }, [])
    expect(audit(root).sites.map(s => `${s.path}:${s.line} ${s.kind}`)).toEqual([
      'src/a.ts:1 spawn-frame',
      'src/b.ts:1 resume-frame',
      'src/c.ts:1 claude-launch',
      'src/c.ts:2 claude-launch',
      'src/d.ts:2 broker-handler',
    ])
  })

  it('passes when every site is recorded', () => {
    const root = tree({ 'src/a.ts': SENDER }, [door('src/a.ts', 'spawn-frame')])
    expect(report(audit(root))).toMatchObject({ ok: true })
  })

  it('fails a planted new sender, naming path and line', () => {
    const root = tree({ 'src/a.ts': SENDER, 'src/new.ts': `\n${SENDER}` }, [door('src/a.ts', 'spawn-frame')])
    const out = report(audit(root))
    expect(out.ok).toBe(false)
    expect(out.text).toContain('UNAUDITED src/new.ts:2 (spawn-frame)')
  })

  it('fails a planted direct claude launch', () => {
    const root = tree({ 'src/x.ts': "execFile('claude', ['-p'])\n" }, [])
    expect(report(audit(root)).text).toContain('UNAUDITED src/x.ts:1 (claude-launch)')
  })

  it('fails a record whose site no longer exists', () => {
    const root = tree({ 'src/a.ts': 'export {}\n' }, [door('src/a.ts', 'spawn-frame')])
    const out = report(audit(root))
    expect(out.ok).toBe(false)
    expect(out.text).toContain('STALE src/a.ts (spawn-frame)')
  })

  it('keeps an external exception without calling it stale', () => {
    const root = tree({ 'src/a.ts': 'export {}\n' }, [
      { ...door('review tooling', 'claude-launch'), external: true },
    ])
    expect(report(audit(root)).ok).toBe(true)
  })

  it('ignores tests, comments and type references', () => {
    const root = tree(
      {
        'src/__tests__/a.test.ts': SENDER,
        'src/b.ts': "// { t: 'spawn' }\ntype T = Extract<M, { t: 'spawn' }>\n",
      },
      [],
    )
    expect(audit(root).sites).toEqual([])
  })

  it('passes on the real tree', () => {
    const out = report(audit(REPO))
    expect(out.text).toMatch(/: ok$/)
    expect(out.ok).toBe(true)
  })
})
