#!/usr/bin/env node
// Prints the commit the egress scan of a main push should start from.
//
// Main pushes share one concurrency group, so a queued run is replaced by a newer
// push and its commits are never scanned by it. Scanning from the previous tip
// (github.event.before) would then skip them. Instead the range starts at the
// newest commit whose main run succeeded, which covers every commit since the
// last scan that actually completed, cancelled or failed runs included.
//
// Usage: egress-base.mjs <head-sha>, workflow runs as JSON on stdin (newest
// first, as the API returns them). Exits 1 when no successful run's commit is an
// ancestor of <head-sha>: the previous tip is not a trustworthy base, because a
// rewritten or superseded history would leave commits unscanned.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [head] = process.argv.slice(2)
if (!head) {
  console.error('usage: egress-base.mjs <head-sha> < runs.json')
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
if (!Array.isArray(runs)) {
  console.error('egress-base: expected a JSON array of workflow runs')
  process.exit(1)
}
const green = runs.find(
  run => run.conclusion === 'success' && run.head_sha !== head && isAncestor(run.head_sha),
)
if (!green) {
  console.error('egress-base: no successful main run is an ancestor of the head; refusing to guess a base')
  process.exit(1)
}
process.stdout.write(`${green.head_sha}
`)
