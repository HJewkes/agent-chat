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
a name risks silently granting the wrong tool set. Profile choice fixes the model
(`explorer`/`reviewer` = sonnet, `implementer`/`peer` = opus); there is no separate
`model` parameter.

| Old vocabulary                                  | Now call                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subagent / hand off / async agent (writes code) | `agent_spawn(profile: "implementer", ...)` (own worktree) or `profile: "peer"` (shares your checkout)                                                                                                                                                                                        |
| search / find / explore (read-only)             | `agent_spawn(profile: "explorer", ...)`                                                                                                                                                                                                                                                      |
| review / narrow checks                          | `agent_spawn(profile: "reviewer", ...)`                                                                                                                                                                                                                                                      |
| plan / design the approach                      | No profile replicates the old `Plan` subagent's read-only, architecture-focused framing. Spawn `explorer` to investigate, then synthesize the plan yourself — don't silently treat another profile as equivalent.                                                                            |
| **"fork me" / "with your context"**             | **Not currently possible.** Every `agent_spawn` starts a fresh process from only the `brief` text — none inherit a running conversation's context or prompt cache. Say so explicitly rather than substituting a different profile. Tracked as **CC-44** in the `claude-channels` initiative. |

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

## Talking to a spawned agent or peer

- `chat_send(to: name, text: ...)` — reach a specific peer. Fire-and-forget; no reply
  unless they send one.
- `chat_ask` — escalate a question, e.g. to the human queue.
- `chat_activity(name)` — check on a running peer without disturbing it (read-only).
- `chat_list` — see who else is registered before starting work that could overlap.

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
