---
name: agent-orchestration
description: Spawn, message, or check on agents on this machine. Use this instead of the built-in Agent tool or SendMessage, which are denied machine-wide as of 2026-07-31 — any attempt to delegate, hand off work, search/explore, fork, or reach a teammate should invoke this skill first.
---

# Agent orchestration via agent-chat

Claude Code's built-in `Agent` tool and `SendMessage`/agent-teams machinery are denied
in `~/.claude/settings.json` on this machine, as a deliberate experiment. All agent
dispatch goes through the **agent-chat MCP plugin** instead. Full rationale and the
exact settings.json diff to unwind this live in
`~/projects/agent-chat/docs/replacing-built-in-agent-dispatch.md` — read that if
anything here is confusing or if the built-in tools ever need to come back.

## Step zero: load the tools

agent-chat's MCP tools are deferred by default and will not appear in your tool list
otherwise. Before doing anything below, run:

```
ToolSearch("select:mcp__plugin_agent-chat_agent-chat__chat_register,mcp__plugin_agent-chat_agent-chat__agent_spawn,mcp__plugin_agent-chat_agent-chat__agent_profiles,mcp__plugin_agent-chat_agent-chat__chat_send,mcp__plugin_agent-chat_agent-chat__chat_list,mcp__plugin_agent-chat_agent-chat__chat_activity")
```

Then call `chat_register` before your first substantive tool call this session — it's
free, and it's how spawned agents and peers can address you back.

## Dispatch vocabulary

Call `agent_profiles` before every `agent_spawn` — profile grants change, and guessing
a name risks silently granting the wrong tool set. That call is also the only place
user-installed profiles appear: `agent_profiles` reads `~/.agent-chat/profiles/*.json`
as well as the builtins, so the list is longer than this table and longer than
anything in the repo.

Profile choice fixes the model (`explorer`/`reviewer`/`implementer-lite` = sonnet,
`implementer`/`peer`/`planner` = opus); there is no separate `model` parameter.

| Old vocabulary                                       | Now call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subagent / hand off / async agent (writes code)      | `agent_spawn(profile: "implementer", ...)` (own worktree) or `profile: "peer"` (shares your checkout)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| the same, but the brief is SMALL and fully specified | `agent_spawn(profile: "implementer-lite", ...)` — sonnet, with `implementer`'s grants and worktree isolation. Pick it when the diff is S-sized, the tests are named, and no design judgement is required. Pick `implementer` (opus) the moment the brief needs a decision made.                                                                                                                                                                                                                                                                          |
| search / find / explore (read-only)                  | `agent_spawn(profile: "explorer", ...)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| review / narrow checks                               | `agent_spawn(profile: "reviewer", ...)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| plan / design the approach                           | `agent_spawn(profile: "planner", ...)` — opus, shares your checkout, may write its plan file and run tests, but Edit and state-changing git verbs are denied. Its deliverable is a plan file, not code; see "Splitting a large assignment" below.                                                                                                                                                                                                                                                                                                        |
| **"fork me" / "with your context"**                  | `agent_spawn(inherit: "context", ...)` — the agent starts from a copy of YOUR conversation instead of an empty one (CC-44). It can only fork you: there is no field for whose context, and forking a peer is refused. Not the cheap built-in `fork` — it is a separate process paying its own input tokens — and it sees only your COMPLETED turns, never the one you are in. It also inherits everything you have said, including what its profile was never meant to see, so prefer a written `brief` unless the context genuinely cannot be restated. |

Every spawn `brief` contains, in order: task scope (one domain) — context needed to act
without asking (including exact file:line locations you already found, so the agent
doesn't re-search for them) — explicit constraints ("do NOT touch X") — return format.

For parallel dispatch, also name: the other agents running alongside this one, their
worktrees, and any files that might overlap between them.

State explicitly where the agent should work (its own worktree vs. your shared
checkout) whenever it isn't the obvious default — e.g. uncommitted changes in the
main checkout that a fresh worktree wouldn't see.

If the ticket rests on an assumption you haven't verified, name it and ask the agent
to check it before building on it — testing beats assuming.

### Which Claude account the agent spends

A spawned agent runs on **your** account, not the broker's. Its `CLAUDE_CONFIG_DIR` is
resolved in this order (CC-100): an explicit `config_dir` argument, then your own config
dir as your MCP server sees it, then the `briefing` initiative's declared `profile:`
(`~/.claude-profiles/<profile>`), then the broker's. You do not have to pass anything —
the default is already your account, which is the point: before CC-100 every agent
inherited whatever dir the detached broker daemon happened to start with, and agents
spawned from a session on a dedicated account quietly billed `~/.claude` until it hit its
spend limit. Pass `config_dir` only to bill an account deliberately; it must exist and be
under your home directory, and a bad value is refused rather than quietly replaced. The
resolved account shows up on `agent_list` and `chat_list` rows (`account: <name>`), and
that is also how a peer's transcript and budget stay findable when it is not on your
account.

### Splitting a large assignment: explore, then implement

In worker forensics over 411 assignments (2026-09), 43% were past 150k context at their
first deliverable, and removing avoidable reads would have moved only 16% of those under
it. The explore phase alone reached a median of 142k before the first edit. So the
cheapest cut is not a cap mid-implementation. It is two agents: a `planner` that reads
the code and writes a plan file, and a fresh `implementer` whose brief is that plan.
Source: `claude-channels/sources/long-horizon-research/worker-forensics-report.md` §8.

**When to split.** Split when either signal holds at spawn time:

- The active-work task `estimate` is **3 or more**. This threshold is PROVISIONAL.
  Estimate ≥ 2 had a lift of only 1.20 in the forensics, and 2 is the most common value,
  so it would split too much. CC-137 populates estimates so the number can be calibrated.
- The brief matches a signal with lift above 1.5: it says "screenshot" (lift 1.81, 77%
  precision), the repo is `voltras-mcp` (1.61), or it asks to migrate or port code in
  `voltras-mcp` (81% precision). "round", "storybook" and brief length fall below 1.5 and
  do not trigger a split on their own.

Otherwise dispatch a single `implementer` as before. There is no hard context limit: a
split happens at the explore-to-implement seam or not at all, never mid-task. The human
reviews the measured results (context at first deliverable for split assignments against
the 142k baseline) before the split becomes the default.

**The planner brief.** Spawn `planner` with `cwd` set to the target repo. It shares that
checkout and holds no worktree slot, so tell it which commit to read (for example
`git fetch` then `git show origin/main:<path>` when the checkout lags). The brief names
the plan file path, in the initiative's `sources/` directory:
`~/Library/Application Support/active-work/<initiative>/sources/<task-id>-plan.md`.
The plan file must contain:

0. **Inventory**, before any design: for each need, the existing unit it reuses (a row in
   titan-platform's `CAPABILITIES.md`, or `file:line` elsewhere) or the gap and its task id;
   and for every model or tool call, the runtime path, the credential it needs, and the
   smoke check that proved it. A plan without this section is returned, not dispatched.
1. **Goal and done-when**, restated from the task in one paragraph.
2. **Touch points** as `file:line`, each with the change it needs in one line.
3. **Slices**, each PR-sized (one logical change, reviewable alone), with the touch points
   it owns and what it must not touch.
4. **Tests per slice**: the test file, the scenario, and one mutation the test catches.
5. **Risks and unverified assumptions**, each with how the implementer should check it.
6. **Ordered dispatch**: which slices run in sequence and which can run in parallel, with
   any overlapping files named.

The planner reports the plan path via `chat_send` with the usual return contract. Read
the plan before dispatching; editing it is cheaper than a wrong implementation.

**The implementer brief.** One `implementer` per slice, or one for the whole plan when
the slices are sequential and small. The brief is short because the plan carries the
context:

```
Your brief is this plan file: <absolute path to plan>.
Implement slice <N> ("<slice title>") only. Read the plan first; do not re-explore
beyond the touch points it names unless one proves wrong, and if one does, say so in
your report rather than silently widening scope.
Constraints: <anything not in the plan: files other agents hold, branch naming>.
Report via chat_send to <your name>: Status, PR number, the mutation its test catches,
and any plan assumption that turned out false.
```

## Talking to a spawned agent or peer

- `chat_send(to: name, text: ...)` — reach a specific peer. Fire-and-forget; no reply
  unless they send one.
- `chat_ask` — escalate a question, e.g. to the human queue.
- `chat_activity(name)` — check on a running peer without disturbing it (read-only).
- `chat_list` — see who else is registered before starting work that could overlap.

### When `chat_send` answers `no_channel`

That peer was started without agent-chat on its `--channels` flag, so it takes the
message into its inbox but is **never woken by it**. This is not a failure and not
something to retry — resending only adds to a pile nobody is reading. Do not wait on
a reply; say so plainly and carry on, or reach the human instead.

If you are told this about **yourself** — or your own peers seem to be ignoring you —
you are the unwoken one. Arm the pull path, which does not depend on a push you
cannot receive:

```
Monitor(command: "agent-chat watch <your-name>",
        description: "agent-chat messages for <your-name>",
        persistent: true)
```

It starts at the log head, so it will not replay a backlog at you. Use
`agent-chat watch <name> --once --since all` to read what you already missed.

## Follow-ups: send them to a fresh worker

A worker that has sent its first Status report is usually carrying its whole assignment in
context, and every later turn pays for all of it again. A follow-up (review fixes, a second
task on the same branch, a cold wake hours later) costs far less in a new session that starts
from the report than in the old one. This is advice, not a cap. Use it when both are true:

- the worker has delivered its first Status report, and
- its context fill (the roster's segment, or `session_budget(name)`) is above its role's
  advisory threshold. The thresholds are `DEFAULT_CONTEXT_HINTS` in `src/config.ts`,
  overridable by `contextHints` in `~/.agent-chat/config.json`. At the time of writing:
  implementer and implementer-lite 200k, peer 250k, any other profile 250k. Explorer,
  reviewer, researcher and planner have none, so keep their follow-ups in place.

Then spawn the successor with `agent_spawn(..., predecessor: "<old name>")` instead of a
`chat_send` to the old session. The broker adds a Predecessor section ahead of your brief:
the old worker's newest `chat_send` to you, its branch and worktree, and its session id and
transcript path. Your brief only has to say what to do next. Pass the same `worktree` (or
`cwd`) so the successor works on the existing branch instead of allocating a new one. Only
the agent's own spawner can name it as a predecessor.

Keep the follow-up in place when it depends on what the worker holds in context and not in
the report: a debugging trail it has not written down, or a decision it is midway through.
For a finished worker that is not retired, use `agent_resume`. For a retired one, use
`agent_spawn resume_session: "<session id>"` (CC-126). Both continue the old conversation
instead of starting fresh.

The spawn never retires the predecessor. It warns while the old worker is unretired. Once
the successor registers, retire the old worker, or leave it parked if you might still need
its conversation. One exception: if the successor adopted a worktree that the predecessor
allocated, leave the predecessor parked until the successor's branch is merged. Retire
releases the worktree the retired agent allocated, even while the successor is working in it.

## Budget: what you are spending, and how to find out

`agent_list` and `chat_list` rows already carry each peer's model, session cost and context
fill (CC-94) — that is where to look first when deciding who takes the next context-heavy
job, since it costs no round-trip. Reach for `session_budget(name)` when you need more than
the roster's compact segment: token breakdown, cache figures, or the full rate-limit table
for one peer.

`session_budget` answers two different questions, and a coordinator should treat them
differently.

**Your own context fill** is per session. You do not have to poll for it: when you cross
70%, 85% or 95%, a `[budget]` line is appended to the next peer message you receive. When
it appears, act on it at your next natural stopping point rather than finishing one more
thing — `agent_teleport` ends this session and starts a successor on the current build,
keeping your name so peers can still reach you. Your transcript does not travel, so the
handoff you write is all the successor gets. That is why 95% says stop now: past it there
is not enough room left to write a good one.

**The account rate limit is machine-wide and shared.** It is not billed to you, and nothing
pushes it. `agent_list`/`chat_list` print it once, in the header, from whichever row's
reading is freshest — never per row, since it is one fact, not N. Call `session_budget`
when you are about to make a decision that spends it and want a guaranteed-current read.
`five_hour` recovers within a working session; `seven_day` does not, so it is the one that
constrains a day's plan. Use it to shape the work rather than to stop:

- Above ~85% on `seven_day`, prefer `implementer-lite` or `explorer` (sonnet) over the opus
  profiles for anything that does not need judgement, and narrow briefs so an agent does
  less rediscovery.
- Spawn fewer agents doing more each, rather than many doing little. Every agent pays full
  price to rebuild context the brief could have given it.
- Check before a wave, not after. Finding out at 96% that five agents are queued is worse
  than finding out at 80% that the wave should be three.
- The figure a spawned agent reports for ITSELF can be stale: an idle session keeps
  publishing the fill it had when it stopped. Read `age_seconds` and `stale` before quoting
  a number back to a human — the roster segment marks this too (`[stale Ns]`), rather than
  smoothing it over.

### The coordinator is the most expensive seat

The session doing the coordinating is usually the largest model on the machine and the one
whose context is read on every subsequent turn. Every low-leverage, high-context read it does
itself — mining a note corpus, reading a routine PR diff in full, paging through recon output —
makes every later triage and coordination turn cost more, because the window is fuller. Treat
its context as the scarce resource, not the agents' time.

- Corpus mining, literature digests, recon over many files: spawn `implementer-lite` (sonnet,
  `isolation: none` when it must not hold a worktree slot) or `explorer`, have it WRITE a
  digest file, and read only its <10-line report.
- PR gating: keep one standing sonnet `reviewer` per wave; send it PR numbers and read its
  verdict. Read a diff yourself only where the judgement is the point (safety paths, lifecycle
  and migration changes), not for routine hygiene PRs.
- Before any read that will return more than ~100 lines, ask whether a sonnet agent could
  return a 10-line answer instead.
- `session_budget(name)` returns a PEER's `model_id`, `cost.total_cost_usd` and context
  fill as well as your own. Use it to see which seats are expensive before deciding who does
  the next context-heavy job.

## Return contract

Agents report: `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, under 15
lines, detail to a file. State in every brief that plain-text stdout is invisible to
you and the report must come back via `chat_send` — don't assume a return-format
block implies the channel. Escalating rather than guessing is always fine — bad work
is worse than no work.

Verify agent output before committing it — a passing test count isn't proof:

- Ask for one concrete mutation the agent made and which test caught it, not just
  that tests currently pass.
- Ask what the agent actually _saw_ in each state (a render, a screenshot), not just
  whether errors were thrown — a broken or blank state can throw nothing.
- Require claims to carry checkable evidence (e.g. a named CI run), not a bare
  verdict like "pre-existing failure, trust me."
