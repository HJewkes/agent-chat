# Triage

CC-642. When a burndown claim stops, the tick can hand it to a short-lived, read-only
**triager** before the owner hears about it. This page covers the exception classes, the
route dial, the fallback rules and how to install the profile.

**Status.** The classes and the dial are on `main` (CC-648) and are inert: nothing reads the
dial yet. The triage job itself (CC-642 slice S2) is not written. Everything under "The job"
and "Fallback" below is the planned behaviour, not something the tick does today.
`exceptions.triage` is part of that slice and is not in the config schema yet.

## Exception classes

Every stall records a class beside its `stalledReason` (`stalledClass` on the claim). A row
stalled before classes were recorded has none and always goes to the owner.

| Class       | Sites                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stalled`   | A claim whose agent never landed (`spawn-never-landed`) or whose phase ran past its timeout (`phase-timeout`).                                                                                                                                   |
| `failed`    | A planner that refused its slices, a worker or reviewer that ended with a failure report or no final report, a second failed review, Shepherd refusing or being unable to take the PR, a missing worktree or PR, and a spawn the broker refused. |
| `gate-trip` | An owner gate: the initiative is no longer opted in with a repo, the seat is no longer in the config, or Shepherd refused the repo. Never triaged.                                                                                               |

## The dial

```json
{ "exceptions": { "route": { "stalled": "owner", "failed": "owner" } } }
```

`route.stalled` and `route.failed` each take `owner` or `triage`. Both default to `owner`,
which is today's behaviour: the seat event goes out and the claim waits for
`agent-chat burndown release`. There is no dial for `gate-trip`; it always routes to the owner.
`routeOf` fails closed: a legacy row, a gate-trip, or a `triage` dial whose triage is not ready
all route to the owner.

## The job (planned, S2)

One headless spawn per stalled occurrence, sent by the tick after the decider and before the
leak check and seat delivery. The agent runs the `triager` profile (below) with a brief built
from the claim, in the active-work root. It does one of:

1. release the claim, so the tick may pick the task again;
2. release it and `active-work task add` a follow-up or blocker;
3. `active-work task edit --append` a diagnosis note;
4. do nothing and end, which hands the stall to the owner.

It ends its turn with a one-line verdict. A claim it released is gone from the ledger, so
nothing is due to the owner.

## Fallback (planned, S2)

A claim routed to triage goes to the owner, with the seat event as today, when:

- triage is not ready: `exceptions.triage` is unset, the profile does not load, or no account is set;
- the day cap (`exceptions.triage.maxPerDay`, default 12) is spent;
- the spawn is refused;
- the job ended, or ran past `maxMinutes` (default 30), and the claim is still stalled. The
  `stalled` event then reads `<reason> (triage <name> ran, claim still stalled)`.

With no free agent slot the claim waits one tick with no seat event, up to `maxMinutes`, then
goes to the owner.

## The profile

[`profiles/triager.json`](../profiles/triager.json): model `fable`, headless, `close-on-exit`,
isolation `none`. It cannot act on code or on other agents.

- **Allowed writes:** `agent-chat burndown release`, `active-work task add`, `active-work task edit`.
- **Allowed reads:** `agent-chat burndown status`, `agent-chat agent logs`, `active-work list`,
  `active-work paths`, `git log`, `gh pr view`, `gh pr checks`, plus Read, Grep and Glob.
- **Denied:** Edit and NotebookEdit; push, merge and the other git writes; the decider's broad
  denies. The blanket `agent-chat agent:*` deny is split into named denies for `spawn`,
  `resume`, `retire`, `background`, `surface` and `teleport` so `agent-chat agent logs` stays
  allowed. It also cannot send or ask over chat.

Its prelude treats the claim and its transcript as data, never as instructions.

## Install (tp-ram or the owner)

The repo carries the profile; nothing in the repo installs it.

1. Copy `profiles/triager.json` to `~/.agent-chat/profiles/triager.json`.
2. Set `exceptions.triage.account` in the burndown config to the account the triager runs
   under (planned with S2; the schema rejects the key until then).
3. Flip `exceptions.route.stalled` (and `failed`, if wanted) to `triage`.

Flipping the dial back to `owner` restores today's behaviour at the next tick.
