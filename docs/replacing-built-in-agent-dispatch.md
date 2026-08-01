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

## The known gap: fork

Every `agent_spawn` profile starts a brand-new `claude` CLI process that begins with
only the `brief` text you give it — none of the calling session's conversation history.
The built-in `fork` subagent type is fundamentally different: it shares the parent's
prompt cache and full context at near-zero marginal cost. Nothing in agent-chat today
replicates that. Filed as **CC-44** in the `claude-channels` initiative — add fork-like
mechanics (spawn that inherits/shares context cheaply) to agent-chat's spawn surface.
Until that lands, tasks that would have used `fork` have no good replacement here; treat
that as a real capability loss for the duration of this experiment, not just a paper cut.

## Unwinding this

If the experiment causes enough pain to abandon, in `~/.claude/settings.json`:

1. Add back: `"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }` at the top level.
2. Remove `"Agent"` and `"SendMessage"` from `permissions.deny`.

That fully restores prior behavior — nothing else in this repo or in Claude Code's own
config was touched.
