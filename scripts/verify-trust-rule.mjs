#!/usr/bin/env node
// Prints the startup trust-check code from an installed Claude Code bundle so a
// new release can be compared by eye against docs/trust-rule-versions.md.
// Usage: node scripts/verify-trust-rule.mjs <version>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractProbes } from './trust-rule-probes.mjs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: verify-trust-rule.mjs <version, e.g. 2.1.289>')
  process.exit(2)
}
const bundle = fs
  .readFileSync(path.join(os.homedir(), '.local/share/claude/versions', version))
  .toString('latin1')

for (const { label, at, code } of extractProbes(bundle)) {
  console.log(`## ${label}${at < 0 ? '' : ` (offset ${at})`}`)
  console.log(code ?? 'NOT FOUND')
  console.log()
}
