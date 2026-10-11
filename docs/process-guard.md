# Process guard (CC-495)

The broker reads the process table every 2 s. It looks for a runaway: a process of its own uid
whose rss is above `processKillBytes`. What it does next depends on `processGuardMode` in
`config.json`. The broker reads both keys on every tick, so a change takes effect on the next
poll without a restart.

| `processGuardMode`                                     | Effect                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `log` (default, and the fallback for an unknown value) | Logs `process_over_limit` to the broker log once per runaway per 10 minutes. Sends no signal.          |
| `kill`                                                 | Sends SIGKILL and logs `process_killed`. If the process is still alive after 10 s, it is killed again. |
| `off`                                                  | Does not run `ps`.                                                                                     |

`processKillBytes` defaults to 8 GiB. A value below 1 GiB is rejected as a typo and the 8 GiB
default is used. An invalid value is logged as `config_invalid` once per distinct bad content.

## Who counts as a victim

A victim is **any** process that descends from the broker, from a `claude` process or from
`titan-factory`. The roots themselves are never victims. Ownership is proved by live ancestry,
not by CC-898's launch identity, so the guard is wider than the orphan reaper. It covers:

- owner-attached interactive sessions and everything they run,
- MCP servers a session starts, such as a Playwright browser,
- reviewer and implementer test runs, builds and model loads.

A legitimate large job in any of these is killed in `kill` mode. **The guard is opt-in for that
reason.** It ships in `log` mode. Read the `process_over_limit` rows in the broker log before you
set `kill`.

## Never killed

The guard never kills these processes, even above the limit:

- the broker, its ancestors and pid 1,
- processes of another uid,
- agent-chat's own broker, `run-agent` launchers and MCP servers, and tmux (CC-898's daemon rule).

A spared daemon above the limit is logged as `process_over_limit` with a `spared` field.

## Not covered

- **Brokers under an ephemeral (test) home.** They never start the guard.
- **Other hosts.** The guard sees only the broker's own machine.
- **Spikes between polls.** Detection happens only every 2 s, so a fast runaway can overshoot
  the limit before it is killed.
- **Swapped-out memory.** rss counts only memory that is resident. On a 10 GiB probe with no
  memory pressure, `ps` rss matched `VmRSS` exactly and `VmSwap` was 0.
