# Dispatch known issues

Failures of the burndown tick that are understood, with what the tick does about them now.
Add an entry when a dispatch failure has a known cause; name its task.

## A slow broker failed the whole tick (CC-1343)

**Symptom.** Ticks dispatch 0 while hundreds of tasks are ready. `titan-factory service check`
reads `tick failing ... N times in a row`. `burndown-kick.log` shows
`broker did not answer inbox_since_result` or `broker did not answer agents_result`, and
`broker.log` shows `burndown_tick_failed`. Seen on 2026-10-14, including after restarts that
carried CC-1309.

**Cause.** The broker answers `agents` and `inbox_since` synchronously, so a slow roster build
holds every other request behind it. An `inbox_since` read for one parked claim then timed out,
rejected `observe()`, and failed the tick, so nothing was dispatched. Replies were also matched
to requests by type in FIFO order, so a reply arriving after its request timed out would have
answered the next request of that type.

**What the tick does now.**

- A timed-out request rejects with `BrokerTimeoutError` and leaves a tombstone that swallows its
  late reply, so the reply cannot answer a later request.
- `inbox_since` waits 15 s, not 5 s. Both it and the live roster read retry a timeout twice,
  after 1 s and 3 s.
- An `inbox_since` that still times out leaves only that parked claim unread for the tick
  (`unread <claim>: inbox unread (broker did not answer inbox_since_result)`). The tick ends
  `ok`, `consecutiveFailures` stays 0, and it dispatches.
- A tick that still fails on a broker timeout, such as a roster read that times out after its
  retries, records `lastErrorClass: BrokerTimeoutError`, so the service check reads
  `tick failing ... (BrokerTimeoutError)`.

**Not fixed here.** The broker is still slow. CC-1309 is the root fix for roster build time; it
does not cover `inbox_since`. `tick failing` is a note cause in the service check and does not
stop the line, so stop-line refusals seen at the same time had some other cause.

Covered by `src/__tests__/burndown-tick-broker-timeout.test.ts`.
