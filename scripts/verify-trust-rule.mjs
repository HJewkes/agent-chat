#!/usr/bin/env node
// Prints the startup trust-check code from an installed Claude Code bundle so a
// new release can be compared by eye against docs/trust-rule-versions.md.
// Usage: node scripts/verify-trust-rule.mjs <version>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: verify-trust-rule.mjs <version, e.g. 2.1.289>')
  process.exit(2)
}
const bundle = fs
  .readFileSync(path.join(os.homedir(), '.local/share/claude/versions', version))
  .toString('latin1')

const probes = [
  [
    'trust check: canonical root, then folder and ancestors up to the git root; flag hasTrustDialogAccepted',
    /function \w+\(\)\{if\(\w+\.CLAUDE_CODE_SANDBOXED\)return!0;if\(\w+\(\)\)return!0;let \w+=\w+\(\),\w+=\w+\(\);if\(\w+\.projects\?\.\[\w+\]\?\.hasTrustDialogAccepted\)/,
    1050,
  ],
  [
    'worktree to main checkout',
    /function \w+\(\w+,\w+\)\{try\{let \w+=\w+\.trim\(\);if\(!\w+\.startsWith\("gitdir:"\)\)/,
    800,
  ],
  [
    'git root finder',
    /function \w+\(\w+\)\{let \w+=Date\.now\(\);\w+\("info","find_git_root_started"\)/,
    420,
  ],
  [
    'global config file',
    /function \w+\(\)\{if\(\w+\(\)\.existsSync\(\w+\(\w+\(\),"\.config\.json"\)\)\)/,
    330,
  ],
]
for (const [label, pattern, length] of probes) {
  const at = bundle.search(pattern)
  console.log(`## ${label}`)
  console.log(at < 0 ? 'NOT FOUND' : bundle.slice(at, at + length))
  console.log()
}
