# The decider

Autonomy slice 3 (`claude-channels/sources/surplus-2026-09-26/autonomous-burndown-design.md`,
section 3). A short-lived Fable agent answers derivable questions in the human queue on
the human's behalf, citing a precedent. It escalates everything else by leaving it queued.

## What the broker enforces

- `decided` frames are accepted only from a registered connection whose durable agent id
  equals `decider.agentId` in `~/.agent-chat/config.json`. Any other connection, including
  the unregistered CLI, gets `not_decider`, and the refusal is logged as `verdict_refused`.
- Only an open `question` that nobody has decided yet can be decided. Approval and
  endorsement requests stay human-only.
- The class must be one of `session_control`, `agent_ops`, `tech_design` or
  `scope_priority`, in the vocabulary of active-work's `precedent search`.
- The stored question text and the answer are both checked against the unlock table in
  `src/broker/decisions.ts`. A match returns `unlock_table` and the question stays queued.
- A decision must carry `precedent`, `basis` and `reversible`.
- `provenance: "decided"` is set by `BrokerCore.decide`, never by the frame.

## What the human sees

`agent-chat inbox` prints a "Decided for you, awaiting your audit" section for 24 hours,
listing each question, the answer and its citation. `agent-chat answer <id> "..."`
overrules the decision. The asker receives the human's answer with no provenance and
`event: overrule`, and the decision records `overruledBy`. `agent-chat dismiss <id>`
accepts the decision and clears it from the section.

## Install (planned restart window only)

1. Merge the PR, then run `npm run build` in the main checkout.
2. Restart the broker in the window: `agent-chat service restart`.
3. Copy the profile: `cp profiles/decider.json ~/.agent-chat/profiles/decider.json`.
4. After spawning a decider, set its durable id in `~/.agent-chat/config.json`:
   `"decider": { "agentId": "<id from agent-chat agent ls>" }`. The broker reads this
   on every frame, so changing it needs no restart. Leave the key absent to disable
   deciding entirely.

## Woken by the burndown tick (slice 4f)

One durable decider serves every wake. The human spawns it once and sets `decider.agentId`
once; the tick never spawns, retires or reconfigures it, and never writes `config.json`.
Add the block to `~/.agent-chat/burndown.config.json`:

```json
"decider": { "name": "decider", "maxPerHour": 4, "maxPerDay": 24 }
```

Every tick first checks the decider's identity, so `agent-chat burndown tick --once --dry-run`
confirms the setup even with an empty queue. When the human queue holds an open `question`
older than 5 minutes that arrived after the last wake, the tick resumes that name headless
with a message telling it to process the open queue and end its turn. It skips the wake,
and says why, when:

- the roster's agentId for the name differs from `decider.agentId`, the name is retired or
  missing, or `decider.agentId` is unset. These are recorded in the ledger's `decider.refused`
  and shown by `agent-chat burndown status`;
- the decider is already running;
- the wakes in the last hour or day reach `maxPerHour` or `maxPerDay`, counted from
  `decider.wakes` in the ledger, which the tick writes under the ledger lock before it
  sends the frame;
- `maxAgents` or the broker's free slots leave no room. A running decider counts against
  `maxAgents`. The budget reserve does not apply to it.
