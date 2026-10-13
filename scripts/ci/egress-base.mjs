#!/usr/bin/env node
// Prints the commit the egress scan of a main push should start from.
//
// Main pushes share one concurrency group, so a queued run is replaced by a newer
// push and its commits are never scanned by it. Scanning from the previous tip
// (github.event.before) would then skip them. Instead the range starts at the
// newest commit whose main run succeeded, which covers every commit since the
// last scan that actually completed, cancelled or failed runs included.
//
// Usage: egress-base.mjs <before-sha> <head-sha>, workflow runs as JSON on stdin
// (newest first, as the API returns them). Falls back to <before-sha> when no
// successful run's commit is an ancestor of <head-sha>.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [before, head] = process.argv.slice(2)
if (!before || !head) {
  console.error('usage: egress-base.mjs <before-sha> <head-sha> < runs.json')
  process.exit(2)
}

function isAncestor(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const runs = JSON.parse(readFileSync(0, 'utf8'))
const green = runs.find(
  run => run.conclusion === 'success' && run.head_sha !== head && isAncestor(run.head_sha),
)
process.stdout.write(`${green ? green.head_sha : before}\n`)
