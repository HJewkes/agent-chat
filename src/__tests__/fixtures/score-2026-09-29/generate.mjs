#!/usr/bin/env node
// Writes tasks.json: an invented backlog that exercises every score.py term. Deterministic; run with `node generate.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TODAY = '2026-09-29'
const PREFIX = { alpha: 'AL', beta: 'BE', gamma: 'GA', delta: 'DE', epsilon: 'EP' }
const SEVERITIES = ['low', 'medium', null, 'low', 'medium', 'high']
const FILLER_TITLES = [
  'Tidy the widget loader',
  'Rename the sprocket module',
  'Split the gadget parser',
  'Measure the gizmo cache',
  'Batch the doohickey writes',
  'Trim the thingamajig output',
]

function task(slug, n, fields) {
  return {
    id: `${PREFIX[slug]}-${n}`,
    title: fields.title,
    priority: fields.priority,
    severity: fields.severity ?? null,
    estimate: fields.estimate === undefined ? 3 : fields.estimate,
    done_when: fields.done_when === undefined ? 'The change is merged and the suite is green.' : fields.done_when,
    status: fields.status ?? 'open',
    tags: fields.tags ?? [],
    notes: fields.notes ?? '',
    created: fields.created === undefined ? '2026-09-01' : fields.created,
    updated: fields.updated === undefined ? '2026-09-20' : fields.updated,
    done_at: null,
    slug,
  }
}

// Each row names the case it covers; score.py's expected output pins how they rank.
const CASES = [
  // Kinds by tag and by title regex, several severities.
  task('alpha', 1, { title: 'Harden the secret store against injection', priority: 1, severity: 'critical', estimate: 5, updated: '2026-07-01' }),
  task('alpha', 2, { title: 'Add the export feature to the dashboard', priority: 2, severity: 'high', estimate: 2 }),
  task('alpha', 3, { title: 'Normalize the schema for invoices', priority: 3, severity: 'medium', tags: ['kind:correctness'] }),
  // Blocked: waits on AL-2, so it never dispatches and AL-2 gains an unblock.
  task('alpha', 4, { title: 'Ship the invoice screen', priority: 1, severity: 'critical', notes: 'Depends on AL-2 landing first.' }),
  // A dependency on a closed task does not block.
  task('alpha', 5, { title: 'Refresh the pricing table', priority: 4, severity: 'medium', notes: 'Blocked by AL-99; that one is closed.' }),
  task('alpha', 99, { title: 'Closed prerequisite', priority: 9, status: 'done' }),
  // Stop-short: hard-stop words in done_when.
  task('alpha', 6, { title: 'Roll out the billing service', priority: 2, severity: 'high', done_when: 'The service deploys to production and answers a probe.' }),
  task('beta', 1, { title: 'Guard the upload path against leaks', priority: 1, severity: 'critical', estimate: 2, done_when: 'A release tag push follows the fix.' }),
  // Within-initiative tie: identical rows, broken by ID number (BE-9 before BE-10).
  task('beta', 9, { title: 'Stabilize the parser output', priority: 2, severity: 'high', tags: ['kind:product'] }),
  task('beta', 10, { title: 'Stabilize the parser output', priority: 2, severity: 'high', tags: ['kind:product'] }),
  // Same row in gamma; its priority percentile differs, so it does not tie.
  task('gamma', 1, { title: 'Stabilize the parser output', priority: 2, severity: 'high', tags: ['kind:product'] }),
  task('gamma', 2, { title: 'Port the adapter to the new route', priority: 1, severity: 'high', estimate: 12 }),
  // Discovery is not a capped kind: all three reach the top 10. BE-3 and GA-3 tie at equal weight, broken by slug.
  task('beta', 3, { title: 'Survey the queue behaviour', priority: 1, severity: 'critical', tags: ['kind:discovery'], updated: '2026-06-01' }),
  task('gamma', 3, { title: 'Survey the storage costs', priority: 1, severity: 'critical', tags: ['kind:discovery'], updated: '2026-06-01' }),
  task('delta', 1, { title: 'Survey the import formats', priority: 1, severity: 'critical', tags: ['kind:discovery'], updated: '2026-06-01' }),
  // Untriaged: no estimate, or no done_when.
  task('delta', 2, { title: 'Write the operator runbook', priority: 2, severity: 'high', estimate: null }),
  task('delta', 3, { title: 'Expose the metrics api', priority: 3, severity: 'medium', done_when: '' }),
  // Odd severity falls back to unset; odd and missing dates age as 0.
  task('epsilon', 1, { title: 'Consolidate the config readers', priority: 1, severity: 'urgent', updated: '2026-02-30' }),
  task('epsilon', 2, { title: 'Fold the two loaders into one', priority: 2, severity: 'high', updated: 'not-a-date', created: 'soon' }),
  task('epsilon', 3, { title: 'Wire the phone notification', priority: 3, severity: 'high', updated: null, created: null }),
  task('epsilon', 4, { title: 'Cache the voice prompts', priority: 4, severity: 'medium', updated: '2026-08-15T10:30:00Z' }),
  task('epsilon', 5, { title: 'Index the chapter list', priority: 5, severity: 'low', updated: null, created: '2026-05-01' }),
  // Nit and agent-tooling rows that score too low for the top 10, so share caps stay inert.
  task('alpha', 7, { title: 'Fix typo in the footer', priority: 8, severity: 'low', estimate: 1 }),
  task('beta', 4, { title: 'Rotate the worktree budget', priority: 7, severity: 'low', estimate: 1 }),
  task('gamma', 4, { title: 'Tune the spawn cadence', priority: 6, severity: 'low', tags: ['kind:agent-tooling'] }),
  // Weight tie: equal scores, and the heavier epsilon must beat delta despite its later slug.
  task('delta', 6, { title: 'Seal the backup keys', priority: 1, severity: 'critical', tags: ['kind:security'], updated: '2026-09-29' }),
  task('epsilon', 6, { title: 'Seal the export keys', priority: 1, severity: 'high', tags: ['kind:security'], updated: '2026-09-28' }),
  // Excluded tags: a seat tag, and reserved tags the seat's own list leaves out.
  task('alpha', 8, { title: 'Pick a vendor for mail', priority: 1, severity: 'critical', tags: ['parked'] }),
  task('beta', 5, { title: 'Choose the retention period', priority: 1, severity: 'critical', tags: ['needs-decision'] }),
  task('gamma', 5, { title: 'Sign the hosting contract', priority: 1, severity: 'critical', tags: ['human-only'] }),
  task('delta', 4, { title: 'Wait for the upstream fix', priority: 1, severity: 'critical', tags: ['blocked'] }),
  // Excluded title pattern.
  task('delta', 5, { title: 'Spike: try a columnar store', priority: 1, severity: 'critical' }),
]

function fillers() {
  return Object.keys(PREFIX).flatMap((slug, s) =>
    FILLER_TITLES.map((title, i) =>
      task(slug, 20 + i, {
        title,
        priority: 5 + ((i + s) % 4),
        severity: SEVERITIES[(i + s) % SEVERITIES.length],
        estimate: 1 + ((i * 3 + s) % 10),
        updated: `2026-0${6 + ((i + s) % 4)}-1${i}`,
      }),
    ),
  )
}

const snapshot = { capturedAt: `${TODAY}T00:00:00Z`, today: TODAY, tasks: [...CASES, ...fillers()] }
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tasks.json')
fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 1)}\n`)
