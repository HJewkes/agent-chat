# CC-138: `context.related` latency against the live daemon

Measured 2026-09-23 06:30 local, against the running `active-work mcp serve` daemon on
port 7400 (`docs/measurements/cc138-related-latency.md` is this file). 20 distinct,
never-before-seen `context.related` queries, sent exactly as `postRelated` in
`src/agents/related.ts` sends them (`initiative: 'claude-channels'`, `limit: 6`,
`budget: 1500`, `classes: ['notes', 'sources', 'tasks', 'sessions']`, `exclude: []`).
Query text came from paragraphs of the `claude-channels` initiative's `brief.md` and
titles of its open tasks, so each query was new to the daemon's cache.

Load average at measurement time (`uptime`): `4.98 4.70 3.75`. This is lower than the
11-26 range seen during the 2026-09-22/23 spawn outages that motivated CC-138; the
numbers below are a floor, not a worst case.

| stat   | ms   |
| ------ | ---- |
| min    | 354  |
| median | 1105 |
| p95    | 2247 |
| max    | 2247 |

(n=20; p95 and max coincide because the 95th-percentile index over 20 samples lands on
the last one.)

## Decision

p95 (2247 ms) is under the 3000 ms hard cap, so per the rule in the CC-138 brief:
`RELATED_TIMEOUT_MS` moves from 1000 ms to 2500 ms — the smallest 500 ms-rounded value
that covers the measured p95 with margin, and still comfortably under 3000 ms.

Raw per-query timings and the script that produced them are not checked in; the script
lived at `/private/tmp/.../scratchpad/measure-related.mjs` for this session and posted
each query's timing to stderr as it ran.
