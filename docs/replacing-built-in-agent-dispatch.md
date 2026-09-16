# Replacing Claude Code's built-in Agent tool with agent-chat

**Status: experiment, started 2026-07-31.** The human decided to try running with
Claude Code's built-in subagent dispatch (`Agent(subagent_type: ...)`) and its
experimental teammate machinery (`SendMessage`, teammate-idle notifications) turned off
machine-wide, forcing all agent-spawning through agent-chat instead. Rationale: agent-chat
gives durable registration, tags, `chat_list`/`chat_activity` observability, and
addressable-by-name messaging that the built-in tools don't — see the brief's "What this
actually became" section for the fuller context. This is explicitly reversible; see
**Unwinding this** below.

**Day-to-day discoverability lives in the `agent-orchestration` skill** (bundled at
`plugins/agent-chat/skills/agent-orchestration/`), not this doc — its description is
always in the persistent skill listing, unlike this file or agent-chat's own deferred
MCP tool schemas. Invoke it for the actual dispatch vocabulary and step-by-step
instructions; treat this document as the rationale and unwind reference instead.

## What was disabled, and where

`~/.claude/settings.json` (user-level, so machine-wide):

- Removed `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` entirely.
- Added `"Agent"` and `"SendMessage"` to `permissions.deny`.

This blocks every subagent type dispatched through the built-in `Agent` tool —
`general-purpose`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, and
`fork` — plus the harness's own cross-session messaging.

The full built-in-to-agent-chat capability mapping (which profile replaces which
subagent type, how to reach/check on a peer) lives in the `agent-orchestration` skill,
not here — this doc stays narrow to rationale and unwind so the mapping only needs to
be maintained in one place.

One consequence of routing dispatch through profiles rather than a `model` parameter:
choosing the model means choosing a profile. `implementer-lite` exists for that reason
(CC-88) — sonnet, with `implementer`'s exact grants and worktree isolation — so a small,
fully specified brief does not have to be handed to opus to get a worktree. Reach for it
when the diff is S-sized and the tests are named; reach for `implementer` the moment the
brief needs a decision made. It is a user profile in `~/.agent-chat/profiles/`, not a
builtin, so `agent_profiles` is what proves it is installed on a given machine.

## fork: closed, but not at parity

`agent_spawn(inherit: "context")` starts an agent from a copy of the requesting
session's conversation rather than from its `brief` alone (CC-44, landed). That covers
the case the gap was actually costing: work that needs what you have been doing, where
restating it in a brief is the expensive part.

What did NOT come across is the economics. The built-in `fork` shares the parent's prompt
cache at near-zero marginal cost; this is a separate `claude` process that pays its own
input tokens for the inherited conversation, and only an identical prefix landing inside
the 1-hour cache window recovers any of that. Reach for a brief first and `inherit` when
the context genuinely cannot be restated. See `docs/agent-teams.md` §5.7 for the full
semantics, including the in-flight-turn caveat.

## The account a dispatched agent spends

A built-in subagent runs inside the session that dispatched it, so it could not be on a
different Claude account than its parent. Routing dispatch through a broker daemon broke
that for free: `run-agent` built the child's environment from the BROKER's, and the broker
is autostarted by whichever session connects first, so every agent inherited that
session's `CLAUDE_CONFIG_DIR` — usually none. Agents spawned from a session on a dedicated
account wrote their transcripts under `~/.claude/projects/` and died on that account's
spend limit.

CC-100 restores the property the built-in tool had by construction. The child's config dir
is resolved in order: an explicit `config_dir` on `agent_spawn`, the spawning session's own
dir (observed by its MCP server, forwarded on the spawn frame and re-read from its
registration), the `briefing` initiative's declared `profile:`
(`~/.claude-profiles/<profile>`, warn-and-continue if absent), then the broker's own env.
A teleport successor keeps its predecessor's account the same way. The resolved dir is
recorded on the agent's `agent_spawned` row, which is what lets `agent ls`, `agent_list`
and `session_budget` find a transcript or a status-cache reading that is not under the
reader's own `CLAUDE_CONFIG_DIR`.

## Unwinding this

If the experiment causes enough pain to abandon, in `~/.claude/settings.json`:

1. Add back: `"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }` at the top level.
2. Remove `"Agent"` and `"SendMessage"` from `permissions.deny`.

That fully restores prior behavior — nothing else in this repo or in Claude Code's own
config was touched.
