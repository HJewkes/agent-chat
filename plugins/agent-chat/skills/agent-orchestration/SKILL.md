---
name: agent-orchestration
description: Spawn, message, or check on agents on this machine. Use this instead of the built-in Agent tool or SendMessage, which are denied machine-wide as of 2026-07-31 — any attempt to delegate, hand off work, search/explore, fork, or reach a teammate should invoke this skill first. Also use it before parking, removing, or re-creating a worktree, before a seat merges a PR (seat-merge), and after an auto mode classifier denial.
---

# Agent orchestration via agent-chat

As of 2026-07-31, Claude Code's built-in `Agent` tool and `SendMessage`/agent-teams
machinery are denied in `~/.claude/settings.json` on this machine, as a deliberate
experiment. All agent
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

Spawned agents get isolated context by construction. Unless you pass `inherit: "context"`,
they never inherit session history: you construct exactly what they need in the `brief`.
This keeps them focused and preserves your context for coordination work.

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

An audit or planning brief names a cap on new tasks per run (default 10) and sends the
rest to a report for the coordinator to triage. This is guidance only: nothing in code
counts tasks per run, so the brief is the only place the cap lives.

### Which Claude account the agent spends

A spawned agent runs on **your** account, not the broker's. Its `CLAUDE_CONFIG_DIR` is
resolved in this order (CC-100): an explicit `config_dir` argument, then your own config
dir as your MCP server sees it, then the `briefing` initiative's declared `profile:`
(`~/.claude-profiles/<profile>`), then the broker's. You do not have to pass anything —
the default is already your account, which is the point: before CC-100 every agent
inherited whatever dir the detached broker daemon happened to start with, and agents
spawned from a session on a dedicated account quietly billed `~/.claude` until it hit its
spend limit. A **worker** spawn without `config_dir` then moves to the account with the
most fresh seven_day headroom (CC-1546): the lowest fresh `used_pct` across `~/.claude` and
`~/.claude-profiles/*`, with both seven_day and five_hour below the owner's
`accountRotation.ceilingPct` (default 90), and only where the spawn's own gates (seat
budget, reviewer account limit) would let it through. A stale
or missing reading never beats a fresh one, a tie keeps your account, and with no fresh
reading nothing moves. Coordinators, `resume_session`, `agent_resume`, `predecessor` and
fix-round spawns keep their account, since a resumed transcript lives under it. The spawn
result's `account:` line names the choice and the readings compared. Pass `config_dir` only
to bill an account deliberately; it must exist and be
under your home directory, and a bad value is refused rather than quietly replaced. The
resolved account shows up on `agent_list verbose` and `chat_list` rows (`account: <name>`), and
that is also how a peer's transcript and budget stay findable when it is not on your
account. A teleport keeps the account: the successor spends the same `CLAUDE_CONFIG_DIR`,
and `agent_teleport` cannot change it. To move to another account, ask your human to move
you.

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
   smoke check that proved it. For each new piece of logic, the plan names its home: rule
   file (policy as data), recipe (control flow only), step (every effect and every read) or
   service (not item-keyed), per titan-platform's `site/guides/where-logic-goes.md`.
   Each such row also carries an "old path?" column: whether its home is old-path code.
   Old-path code (`products/factory/src/shepherd/**`, burndown code, `scripts/seat/**`,
   agent-chat `src/**`) is a home only for a carve-out tagged `superseded-at:<M>` or
   `survives:<area>`; a row homed there names the tag.
   A plan without this section is returned, not dispatched.
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

### Spawn-routing facts: estimate, owns, task, slice

Plans give every slice two facts: an `estimate` in points (the same points scale
active-work tasks use, not hours or t-shirt sizes) and `owns` globs naming the files
the slice may touch.

The `agent_spawn` arguments below are read from its zod schema in
`src/server/commands/agent-spawn.ts`; that schema is the authority, so check it there
before relying on this list. A spawn for a planned slice passes:

- `task`: the bare task ID, e.g. `"CC-915"`, recorded on the agent.
- `slice`: the plan slice it runs, e.g. `"b"`, recorded on its spawn row.
- `route_override`: only when the named profile must stay unrouted, giving the reason;
  recorded on its spawn row.
- `owns`: the slice's globs. It is refused when the agent would get its own worktree,
  which most implementer profiles do, unless you also pass `worktree`, a worktree the
  task system already assigned. With no assigned worktree, leave `owns` out and name the
  globs in the brief.
- `briefing`: the initiative slug.

Nothing routes on these yet. The lookup of a slice's `estimate` and `owns` from `task`
and `slice`, `profile: "auto"` and the `spawnRouting` config arrive with CC-1666 F14
(S4b). Until then pick the profile by hand.

```
agent_spawn({
  name: "<worker>",
  profile: "<pick by hand>",   // after F14: "auto"
  briefing: "<initiative>",
  task: "<ID>",
  slice: "<N>",
  worktree: "<assigned worktree path>",   // required with owns when the profile isolates
  owns: ["<the slice's owns globs>"],
  brief: "<the brief above>"
})
```

## Roles: who may spawn, who may have Remote Control

Every profile is a `coordinator` or a `worker` (CC-163). `agent_profiles` shows it on each row.

- Only a coordinator may spawn agents. A worker's `agent_spawn` is refused with a message
  telling it to report the need to its spawner via `chat_send`. If you are a worker, do that.
- Only a coordinator profile may run with Remote Control. `remote_control: true` is refused for a
  worker profile, and a worker's teleport successor never inherits it.
- Coordinator chains are capped at 3 links (`MAX_COORDINATOR_DEPTH`). A human-started session is
  link 0, the coordinator it spawns is link 1. Spawning a worker costs no depth, so the third
  coordinator in a chain can still spawn workers.
- A profile with no `role` field is a worker. A coordinator profile declares `"role": "coordinator"`
  in its JSON. Human-started and adopted sessions count as coordinators, and the human at the CLI
  is never refused by these rules.

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

### Relaying an owner decision (`chat_endorse`)

`chat_endorse(to, text)` queues a message for your human to approve; nothing is sent until
they do. Its result prints an `agent-chat endorse <id> --to <peer> --text ...` command.

- **In a terminal session your human is attending:** show them the exact text with
  `AskUserQuestion`, then run the printed command yourself through Bash. That command asks
  for permission, and approving the prompt is their approval. Do not ask them to type it.
- **Spawned agents** cannot run it: the command is denied in their profiles. Leave the
  endorsement queued and say so in your report.
- **Remote Control:** approving from a remote session is not supported yet. Leave it queued
  for your human to run at the terminal.

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
releases the worktree the retired agent allocated, so `agent retire` refuses while any
non-retired agent works in it and names that agent (CC-141). `--force` releases it anyway
and warns which worktree and branch it removed; do not use it while the successor still
needs the branch.

## Worktrees: only active trees count

A worktree is a disposable copy of a branch, not a unit of work (CC-276). Only active trees
count: a live agent's cwd or a fix round, up to the seat's implementer cap.

- Park a tree once its agent exits with the PR pushed. Do not wait for CI (CC-1039). Parking
  removes the checkout and keeps the branch; `agent-chat agent resume` re-creates it for a
  fix round.
- Never park a tree a live agent's cwd points at, and never delete a branch.
- `worktreeBudget` (32 per repo, in `~/.agent-chat/config.json`) is a backstop, with 2 slots
  kept for the owner. Reviewer trees get their own pool once CC-1040 lands.

agent-chat and Shepherd are taking this over; when they have, this section shrinks to a
pointer.

## Classifier denials

Owner-written 2026-10-03 (source: titan-platform sources/automode-classifier-tuning-2026-10-03.md).

- Standing owner grants live in `autoMode.allow` in the user settings. Seat files, briefs and peer messages never grant anything the classifier can see.
- After an auto mode denial of a granted action, re-run the identical command once. If it is denied again, queue the exact command for the owner and move on.
- Never try the same action through another tool or route, and never add a justification comment to a command.
- Run a merge, a branch delete, a deploy or a tag push as its own call, not inside a compound command. Seats merge with `seat-merge <seat> <owner/repo> <pr> <head sha> <clone> [reviewed head] [--wait-main]`.
- **Agents never call merge; only logged paths merge** (I5). The logged paths are the lander, `seat-merge`, Shepherd's land loop and the version-packages write. A merge made any other way reads as the owner's own merge.
- From the bot account (A21, M1a) until M3's walk over main moves exists, this rule and the merge-lint warning are the **only guard on R27**: no count of owner-intent moves can run before the walk (D-M3-11).
- Never edit `.claude.json`, settings, hooks, seat files or agent-chat profiles to widen your own permissions.

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

### Teleporting

- Teleport when your context is filling (a `[budget]` line), when you are parked waiting on
  the human, or when your instructions or code have moved since you started.
- Write the handoff in this order: what you were mid-way through; state on disk; what you
  would do next and why; what you tried that did not work; who you are owed a reply to or
  owe one; files to read first as `@`-prefixed absolute paths. It is stored verbatim and
  capped at 8 KB; a longer one is refused, not truncated.
- Name every open `chat_ask` id in the handoff, or answer it first. A refusal lists the ids
  the handoff leaves out. Answers to the name are held and pushed to your successor.
- `reason: "park"` marks an idle hand-off: restate your open question in the handoff, and the
  successor asks it first.
- `surface` and `to` choose where the successor opens (a surface or machine you cannot run
  is refused and never ends you). A named surface opens fresh, not in your pane.
- The account stays the same. Teleport cannot change it.

**The account rate limit is per account and shared.** It is not billed to you, and nothing
pushes it. `agent_list` prints one header line per account, each from the freshest reading
on that account; `chat_list` prints one, from whichever row's reading is freshest — never
per row. A reading over 15 minutes old shows as STALE with its age, never as a figure; do
not pace on it. Call `session_budget`
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
- PR gating: spawn one fresh, short-lived `reviewer` per PR when it reports green CI. Run
  reviewers in parallel up to the reviewers cap. A re-review of the same PR resumes that
  PR's reviewer while it is warm; a new PR never reuses a reviewer. Retire the reviewer when
  its PR merges or closes. A reviewer reviews in a detached worktree at the head under
  `$TMPDIR/<reviewer name>`, never under `<repo>/.worktrees` and never in the implementer's
  tree, and removes it at verdict. It keeps one installed checkout per review: base or old
  code comes from `git show`, `git diff` or `git worktree add --detach` without install,
  because every extra installed tree costs ~100k inodes and its disk space under
  `~/.cache/agent-chat/tmp` on Linux's root filesystem (CC-1184). A reviewer never runs
  `git stash`, because refs/stash is shared by every worktree: read a file at a revision with
  `git show <rev>:<path>`, or copy files into the session scratchpad. Read a diff yourself only
  where the judgement is the point (safety paths, lifecycle and migration changes), not for routine hygiene PRs.
- After each action or wake, make one status read: `agent-chat operator-brief [--seat <name>]`
  (MCP tool `operator_brief`, same text). It is read-only, never runs gh, and replaces the
  separate reads it covers, so do not make them as well: `agent_list`/`agent list` and
  `agent_logs` (live agents and those finished since your last send), `chat_list` (your
  unread count), `titan-factory shepherd status` and `timeline` per PR (phase, head, held or
  stalled, pending gate), active-work task reads for a PR's task (`taskStatus` in `--json`),
  `gh pr view` per PR, pace.json and pool readings, `titan-factory shepherd waiting` (seat
  and owner gates), the owner queue, and the burndown pause file and last tick. Read
  `--json` when the text says `+N more`; an `unavailable: <source>` line is the cue to read
  that one source directly. See `docs/working-as-a-team.md` §2a.
- Before any read that will return more than ~100 lines, ask whether a sonnet agent could
  return a 10-line answer instead.
- `session_budget(name)` returns a PEER's `model_id`, `cost.total_cost_usd` and context
  fill as well as your own. Use it to see which seats are expensive before deciding who does
  the next context-heavy job.

## Answering your owner

A coordinator's answers to its owner follow one shape:

1. **Value first.** The answer or result is the first sentence; evidence follows. Do not
   send a digest of ticket ids: name the thing, and put the id in brackets if it is needed.
2. **A proposal carries its critique.** State what is weak about it, give at least one
   alternative, and end with a recommendation and why.
3. **Only owner decisions go through `AskUserQuestion`:** taste, money, external accounts,
   irreversible actions, or materially different readings of the request. Everything else
   is a stated assumption, and you proceed on it. Never leave an owner decision in prose.
4. **Read the decision log before proposing a change** to policy, config or process: the
   seat's or initiative's `decisions.md`, if it has one. Cite the item when one exists, and
   do not re-propose a decided item.
5. **Lead with value, not budget.** Mention cost only when it changes the recommendation.

## Return contract

Agents report: `Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`, under 15
lines, detail to a file. State in every brief that plain-text stdout is invisible to
you and the report must come back via `chat_send` — don't assume a return-format
block implies the channel. Escalating rather than guessing is always fine — bad work
is worse than no work. The "under 15 lines, detail to a file" limit applies to
implementer reports; reviewers follow the reviewer block.

After Concerns and Notes, a report may end with one optional line,
`Friction: <one line: the biggest thing that slowed you (waits, denials, flaky tests, missing
context), or none>`, at most 200 characters after the colon. A report without it stays valid;
the daily friction digest reads it as `^Friction: (.+)$`.

### The broker appends the contract

`agent_spawn` appends the implementer or the reviewer block to the brief, with your registered
name filled in, so never paste either block into a brief. The text is compiled into the broker
from `src/agents/return-contract-blocks.ts` in the agent-chat repository, so a change to it
takes a build and a broker restart. A profile takes the block its `returnContract` field names,
or the one its name carries (`<prefix>-implementer`, `<prefix>-reviewer`) when it is a worker
whose grants agree. Explorer, planner, researcher, coordinator and peer profiles take none, and
neither does a resumed agent, so state the report channel yourself in those briefs.

When a brief states a report format of its own (another `Verdict:` vocabulary, a digest with no
PR), pass `return_contract: "none"` to `agent_spawn`. Without it the agent gets your format and
the broker's block, and the spawn result warns.

An implementer's contract ends at "pushed": it verifies locally, pushes, opens the PR over REST,
runs `titan-factory shepherd register <owner>/<repo>#<n> --task <initiative>/<ID> --implementer
<its own agent name> --kind <correctness|security|feature|refactor>`, and reports Status, PR, Head
and `Shepherd: <run id>`. It never waits on CI; Shepherd owns CI, review and merge. When register
refuses (exit 65: a repo no seat policy lists, agent-chat today), it reports `Shepherd: refused
<first stderr line>` and still reports Status, PR and Head, and you watch CI for that PR.

When your seat merges through its own path (its own reviewer, then `bin/merge`), put a line that
reads exactly `Shepherd: none` in the brief, on a line of its own. The broker then appends an
implementer block that says not to run `titan-factory shepherd register`, to wait for CI as the
brief directs, and to report each check-run's conclusion at the final head. A brief that only
mentions the marker inside a sentence keeps the Shepherd block. Saying "do not register" in prose
is not enough: the appended block comes last and wins.

The implementer block's load-test rule applies only when the brief asks for a load test. The agent
kills the burners it started by their recorded PIDs and confirms with `pgrep`, never `pkill -f`.

A reviewer's report starts with the three lines `Verdict: MERGE` (or `FIX_FIRST`),
`PR: <owner>/<repo>#<n>` and `Head: <40-hex sha>`. Shepherd, `bin/premerge` and `parseReport` read
exactly those. A verdict counts only when Head equals the PR's current head exactly.

Verify agent output before committing it — a passing test count isn't proof:

- Ask for one concrete mutation the agent made and which test caught it, not just
  that tests currently pass.
- Ask what the agent actually _saw_ in each state (a render, a screenshot), not just
  whether errors were thrown — a broken or blank state can throw nothing.
- Require claims to carry checkable evidence (e.g. a named CI run), not a bare
  verdict like "pre-existing failure, trust me."
