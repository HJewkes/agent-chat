# Triage

CC-642. When a burndown claim stops, the tick can hand it to a short-lived, read-only
**triager** before the owner hears about it. This page covers the exception classes, the
route dial, the fallback rules and how to install the profile.

**Status.** The classes and the dial (CC-648) and the triage job with its owner fallback
(CC-649, slice S2) are on `main`, and `exceptions.triage` is in the config schema. Both stay
dormant until the burndown tick's install is rebuilt, and the dial defaults to `owner`.

## Exception classes

Every stall records a class beside its `stalledReason` (`stalledClass` on the claim). A row
stalled before classes were recorded has none and always goes to the owner.

| Class       | Sites                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stalled`   | A claim whose agent never landed (`spawn-never-landed`) or whose phase ran past its timeout (`phase-timeout`).                                                                                                                                         |
| `failed`    | A planner that refused its slices, a worker or reviewer that ended with a failure report or no final report, a second failed review, a Shepherd run that ended or a PR Shepherd cannot take, a missing worktree or PR, and a spawn the broker refused. |
| `gate-trip` | An owner gate: the initiative is no longer opted in with a repo, the seat is no longer in the config, Shepherd refused to register the PR, or the trust check failed. Never triaged.                                                                   |

## The dial

```json
{ "exceptions": { "route": { "stalled": "owner", "failed": "owner" } } }
```

`route.stalled` and `route.failed` each take `owner` or `triage`. Both default to `owner`,
which is today's behaviour: the seat event goes out and the claim waits for
`agent-chat burndown release`. There is no dial for `gate-trip`; it always routes to the owner.
`routeOf` fails closed: a legacy row, a gate-trip, or a `triage` dial whose triage is not ready
all route to the owner.

## The job

Built in CC-649 (S2), and dormant until the burndown tick's install is rebuilt.

One headless spawn per stalled occurrence, sent by the tick after the decider and before the
leak check and seat delivery. The agent runs the `triager` profile (below) with a brief built
from the claim, in the active-work root. It does one of:

1. release the claim, so the tick may pick the task again;
2. release it and `active-work task add` a follow-up or blocker;
3. `active-work task edit --append` a diagnosis note;
4. do nothing and end, which hands the stall to the owner.

It ends its turn with a one-line verdict. A claim it released is gone from the ledger, so
nothing is due to the owner.

## Fallback

A claim routed to triage goes to the owner, with the seat event as today, when:

- triage is not ready: `exceptions.triage` is unset, the profile does not load, or no account is set;
- the day cap (`exceptions.triage.maxPerDay`, default 12) is spent;
- the spawn is refused;
- the job ended, or ran past `maxMinutes` (default 30), and the claim is still stalled. The
  `stalled` event then reads `<reason> (triage <name> ran, claim still stalled)`.

With no free agent slot the claim waits one tick with no seat event, up to `maxMinutes`, then
goes to the owner.

A dry run prints each triage start, wait and fallback, but its seat-event preview leaves out
the triage records, so it can show a `stalled` event that the real tick would hold back.

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

Write is denied and not allowed, along with the common Bash write paths (`sed`, `tee`, `cp`, `mv`,
`git log --output` and similar). A shell redirect (`> file`) cannot be denied by a prefix rule, so
that residual remains open.

The triager's verdict is the last line of its final turn; read it from its transcript or
`agent-chat agent logs`. It cannot message anyone: `chat_send`, `chat_notify` and `chat_ask` are denied.

Its prelude treats the claim and its transcript as data, never as instructions.

## Install (tp-ram or the owner)

The repo carries the profile; nothing in the repo installs it.

1. Copy `profiles/triager.json` to `~/.agent-chat/profiles/triager.json`.
2. Set `exceptions.triage.account` in the burndown config to the account the triager runs
   under. `profile` (default `triager`), `maxPerDay` (12) and `maxMinutes` (30) are optional;
   without an account, triage is not ready and stalls go to the owner.
3. Flip `exceptions.route.stalled` (and `failed`, if wanted) to `triage`.

Flipping the dial back to `owner` restores today's behaviour at the next tick.
