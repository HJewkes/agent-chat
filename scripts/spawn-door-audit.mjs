#!/usr/bin/env node
// CC-646: lists every code path that can start a planner or implementer, and fails
// on one that audit/spawn-doors.json does not record (or a record with no site left).
// Usage: node scripts/spawn-door-audit.mjs [root]
//
// Idea ported from dispatch_sidedoor_audit.py in vnx-orchestration (MIT,
// Copyright (c) the vnx-orchestration authors): scan for delivery paths, compare to
// an audited allowlist, fail on the unaudited. This is a TypeScript-tree rewrite.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Each kind is a way to start (or be able to start) a worker; `re` is matched per line. */
export const KINDS = {
  'spawn-frame': /\bt:\s*['"]spawn['"](?!\s*\})/,
  'resume-frame': /\bt:\s*['"]resume['"](?!\s*\})/,
  'claude-launch':
    /\bresolveClaudeBin\(|\bbin:\s*['"]claude['"]|\b(?:execFile|execFileSync|spawn|spawnSync)\(\s*['"]claude['"]/,
  'broker-handler': /\basync handle(?:Spawn|Resume)\(/,
}

// The wire-shape declaration and the resolver's own definition name the kinds without using them.
const DECLARATIONS = new Set(['src/protocol.ts', 'src/agents/claude-bin.ts'])
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.tsx?$/

function sourceFiles(root, dir = 'src') {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...sourceFiles(root, rel))
    else if (/\.tsx?$/.test(entry.name) && !TEST_FILE.test(rel) && !DECLARATIONS.has(rel)) out.push(rel)
  }
  return out
}

const isComment = line => /^\s*(?:\/\/|\*|\/\*)/.test(line)

export function scan(root) {
  const sites = []
  for (const file of sourceFiles(root).sort()) {
    fs.readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isComment(line)) return
        for (const [kind, re] of Object.entries(KINDS))
          if (re.test(line)) sites.push({ path: file, kind, line: i + 1 })
      })
  }
  return sites
}

export function loadRecords(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'audit/spawn-doors.json'), 'utf8')).doors
}

export function audit(root) {
  const records = loadRecords(root)
  const sites = scan(root)
  const recorded = new Set(records.map(r => `${r.path}\0${r.kind}`))
  const found = new Set(sites.map(s => `${s.path}\0${s.kind}`))
  return {
    sites,
    unrecorded: sites.filter(s => !recorded.has(`${s.path}\0${s.kind}`)),
    stale: records.filter(r => !r.external && !found.has(`${r.path}\0${r.kind}`)),
    coordinatorSideDoors: records.filter(r => r.coordinatorSideDoor),
  }
}

export function report(result) {
  const lines = []
  for (const s of result.unrecorded) lines.push(`UNAUDITED ${s.path}:${s.line} (${s.kind})`)
  for (const r of result.stale)
    lines.push(`STALE ${r.path} (${r.kind}): no such site; remove or fix the record`)
  const ok = lines.length === 0
  lines.push(
    `${result.sites.length} sites, ${result.coordinatorSideDoors.length} coordinator side doors: ${ok ? 'ok' : 'FAIL'}`,
  )
  return { ok, text: lines.join('\n') }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { ok, text } = report(audit(path.resolve(process.argv[2] ?? '.')))
  if (!ok) console.error(text)
  else console.log(text)
  process.exit(ok ? 0 : 1)
}
