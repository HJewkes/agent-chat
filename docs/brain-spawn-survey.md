# brain agent-spawning code — characterization

## 1. Spawning

Two independent spawn paths exist:

**A. Interactive launch** — `src/commands/launch.ts:204-207`. Spawns the user's own
foreground `claude` CLI:
```js
spawn(claude, claudeArgs, { stdio: 'inherit', env: { ...process.env } })
```
`claudeArgs` built from: `--append-system-prompt <briefing>` (project briefing text,
`generateSystemPrompt` launch.ts:18-58, pulled from `generateSessionBriefing`),
`--mcp-config <json>` (registers `brain serve` as stdio MCP server, launch.ts:87-93),
`--agents <json>` (subagent defs — `buildDefaultAgents()` launch.ts:60-85, or
project/global `launch.json` override, launch.ts:100-122), `--model`, `--continue`,
`--resume`, plus passthrough user args. `findClaudeBinary()` (launch.ts:10-16) does
`which claude`. No JSON parsing needed — it's a normal foreground TTY session.

**B. Headless dispatch** — `src/server/dispatch.ts:638-682` `spawnClaude()`:
```js
spawn(claudeBin, args, { cwd, env: {...}, stdio: ['pipe','pipe','pipe'], detached: true })
```
argv: `-p --output-format json --model <m> --permission-mode bypassPermissions
--session-id <uuid> --append-system-prompt "On completion output exactly: DONE
<task> <summary>. On failure: FAILED <task> <reason>." --allowed-tools <csv>
--mcp-config <tmp-file-path> --max-budget-usd <n> [--add-dir <workspaceRoot>]`.
Prompt is written to stdin (`proc.stdin.write(opts.prompt); proc.stdin.end()`,
line 678-679) — not passed as an arg. `getClaudePath()` (615-636) checks
`~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then
`which claude`. Env vars passed: `BRAIN_AGENT_ID`, `AGENT_WORKTREE_PATH`,
`BRAIN_PM_TASK`, `BRAIN_PM_CLAIM_TOKEN`, `BRAIN_PM_SESSION`. `proc.unref()` at
dispatch.ts:296 lets the parent exit without waiting.

Prompt content itself is built by `buildWorkerDispatchFromPull` (coordinator.ts:89-136),
which renders a markdown template (`templates/agents/worker.md` etc., placeholders like
`{TASK_ID}`, `{FILE_OWNERSHIP}`, `{VERIFY_COMMANDS}`) via `renderTemplateFile`/
`buildTemplateVariables`, falling back to `buildSpawnPrompt`
(prompt-builder.ts:14-27) → `prompt-templates.ts` `selectTemplate`/`renderPrompt` if no
template file exists.

## 2. Headless vs interactive

Both exist and are cleanly separate code paths (no shared spawn function). Interactive
= `launch.ts` (stdio: 'inherit', TTY passthrough, no output parsing). Headless =
`dispatch.ts` (`-p --output-format json`, stdio piped, detached, unref'd).

Headless output parsing: `setupProcessTracking` (dispatch.ts:684-709) buffers
stdout/stderr chunks; on `exit`, `handleProcessExit` (711-778) does
`JSON.parse(stdout)` against the `{type, subtype, is_error, duration_ms, result,
session_id, total_cost_usd, usage}` shape (`ClaudeJsonResult`, dispatch.ts:138-147).
This is **one-shot JSON parse of the final blob**, not `stream-json` line-by-line
streaming — `--output-format json` not `stream-json`. It also greps the agent's
`result` text for a trailing ```json block (`extractStructuredOutput`,
dispatch.ts:787-802) and for the `DONE/FAILED` completion protocol string
(`parseCompletionMessage`, completion-protocol.ts:28-50).

## 3. Agent identity and tracking

Roster lives in **SQLite** (`agents` table, migration `agentsMigrationV1/V2`,
schema.ts:3-58), one row per spawned agent: `id` (uuid), `name`, `parent`, `status`
(`pending|active|completed|failed|abandoned`, types.ts:1), `brain_task`,
`claim_token`, `branch`, `worktree_path`, `pid`, timestamps, `summary`,
`exit_reason`, and a free-form JSON `context` column (get/set via
`getAgentContext`/`setAgentContext`, data.ts:196-278, used for session_id,
max_budget_usd, claude_result, structured_output, workflow_step, etc.). CRUD in
`src/modules/agents/data.ts`: `createAgent`, `getAgent`, `listAgents` (filter by
status/since/task), `updateAgentStatus`, `findAgentByTask/Branch/PR/Session`.

Liveness: `pid` stored at spawn (`updateAgentStatus(...,'active',{pid})`,
dispatch.ts:289); checked via `process.kill(pid, 0)` (`isAlive`, dispatch.ts:36-43) —
used to dedupe (don't respawn a task with a live active agent, dispatch.ts:419-426).
Reaping is **event-driven**, not a poll loop: the child's own `exit` event
(dispatch.ts:705-708) transitions status to `completed`/`failed` based on exit code
(0→completed if valid JSON+optionally completion parsed; 143→`rate_limited`; other→
`exit_code_N` with stderr tail as summary). `DispatchLoop.waitForAgent`
(dispatch-loop.ts:104-112) separately polls the DB every 5s (`AGENT_POLL_INTERVAL`)
for terminal status when a wave orchestration is waiting on a spawn it issued.
`scripts/check-agents.ts` / `check-all-runs.ts` are one-off manual inspection
scripts, not part of the runtime.

## 4. Coordination

Strictly parent→child; no inter-agent message bus. Children report back via:
(a) process exit code, (b) final stdout JSON blob, (c) a text completion-protocol
line (`DONE <id> <summary>` / `FAILED <id> <reason>`) the system prompt instructs
them to emit, parsed by `completion-protocol.ts`. No stdin communication after the
initial prompt.

Task/status model: PM tasks flow `pending → claimed → in-progress → done/blocked`
(claim via frontmatter rewrite + reindex, `claimTask`/`releaseTaskClaim`,
dispatch.ts:475-545); agent rows flow `pending→active→completed/failed/abandoned`;
delivery rows (separate `delivery_states` table, schema.ts v3/v4) flow
`in-progress→pushed→pr-open→merged/stalled/redispatched` etc. — tracked by
`delivery-monitor.ts`/`delivery.ts` (not fully read, but wired into
`dispatch-loop.ts:199-282`).

Retry/timeout: `DispatchLoop.executeWave` (dispatch-loop.ts:289-365) doubles
`maxBudgetUsd` and respawns once if the agent failed due to
`error_max_budget_usd` (checked via stored `claude_result.subtype`). Stall
detection is separate and heuristic: `stall-detector.ts` shells `git log --grep
<taskId>` to see if there's been a recent commit; no watchdog kills a live
process — it only flags for the delivery/review layer.

Concurrency control: an in-process async `Semaphore` (dispatch-loop.ts:57-78) gates
how many spawns are in flight per wave (`wipLimit`); released when the agent's own
run finishes, independent of downstream delivery/PR monitoring which runs
unbounded in the background.

## 5. Isolation

Git worktrees, one per task: `allocateWorktree` (worktree.ts:108-170) does
`git worktree add -b agent/<workstream>/<taskId> .worktrees/<taskId>` from the true
repo root (`findGitRoot` via `git rev-parse --git-common-dir`, worktree.ts:89-100).
Budget-limited (`DEFAULT_BUDGET=3`, worktree.ts:81, thrown as
`WorktreeBudgetExhaustedError` when exceeded, worktree.ts:129-131) with reclaim of
stale/terminated allocations before allocating (`cleanupStaleAllocations`,
`reclaimTerminatedAllocations`, worktree.ts:326-391, with a 120s
`RECLAIM_GRACE_MS` guard against racing async push/PR creation). `.claude/` config
is copied into each new worktree so hooks fire there too (worktree.ts:153-158).
Release (`releaseWorktree`, worktree.ts:249-301) does `git worktree remove` +
`git branch -D`, refusing unless the tree is clean/pushed (or `force`).
`.worktrees/` at repo root is exactly this mechanism's output dir. cwd for the
spawned process is the worktree path (or `taskRepoDir` for `isolation:'none'`
routing); env isolation is just the `BRAIN_*` vars above, no container/sandboxing.
Also `--add-dir <workspaceRoot>` lets the agent read outside its own worktree for
non-synthetic tasks (dispatch.ts:266-269).

## 6. Definitions

Two layers of agent definitions:

- **Subagent (Claude Code `--agents`) defs** — plain objects with
  `description/prompt/tools/model/permissionMode` (launch.ts:60-85), passed as
  `--agents <json>` to the interactive `claude` process. Overridable via
  `launch.json` (project `.brain/launch.json` or `~/.brain/launch.json`,
  launch.ts:100-122) under an `agents` key.
- **Markdown role templates** — `templates/agents/*.md` (`worker.md`,
  `coordinator.md`, `demo-coordinator.md`, `deploy-agent.md`,
  `research(-collation/-questions).md`, `ux-prototype-builder/reviewer.md`,
  `PROTOCOL.md`). These are prompt bodies with `{PLACEHOLDER}` tokens (CWD,
  PROJECT_DIR, TEAM_NAME, TASK_ID, CLAIM_TOKEN, FILE_OWNERSHIP, WAVE_INFO,
  VERIFY_COMMANDS, etc.), selected by task category/routing
  (`prompt-templates.ts: selectTemplate`) and rendered by
  `template-renderer.ts: renderTemplateFile` + `buildTemplateVariables`
  (`pm/commands/orchestration.ts`). This is what actually becomes the headless
  dispatch's stdin prompt (or the coordinator's `--agent`-style prompt via
  `renderCoordinatorPrompt`, coordinator.ts:38-56).

## 7. Reusability assessment

**Cleanly separable** (little/no brain-DB coupling beyond a generic `db: unknown`
+ raw prepared-statement calls that could trivially swap to any sqlite/kv store):
- `src/modules/agents/worktree.ts` — pure git/fs logic, only touches
  `data.ts`'s worktree_allocations helpers.
- `src/modules/agents/data.ts` — thin CRUD layer over 2 tables; the `toRaw()`
  shim (data.ts:20-25) already tolerates "BrainDB or raw db" — trivial to further
  decouple into any storage.
- `src/modules/agents/completion-protocol.ts` (parse half only — `parseCompletionMessage`,
  `isCompletionMessage`) — pure string parsing, zero deps.
- `src/commands/launch.ts` spawn/argv-building logic (minus `generateSessionBriefing`
  and `BrainDB` import) — genuinely a generic "launch claude with agents+mcp+briefing"
  wrapper; the briefing generator is the only brain-specific piece.
- The headless `spawnClaude`/`setupProcessTracking`/`handleProcessExit` core
  (dispatch.ts:638-778) is conceptually generic (spawn `-p --output-format json`,
  buffer stdio, parse exit) but is written inline against `svc: BrainServiceClass`
  and `getAgent/updateAgentStatus/setAgentContext` — would need those DB calls
  extracted behind a small callback interface (onSpawnError, onExit(code, stdout,
  stderr)) to lift cleanly.

**Deeply entangled** (would need real surgery):
- `src/server/dispatch.ts` as a whole — task claiming/PM status transitions,
  workflow-step metadata resolution, budget-per-category config, and worktree
  allocation are all interleaved with the spawn call in `runDispatch`. The
  *spawn mechanics* (section 1B) are a small, extractable slice; the *task
  sourcing* (`resolveExplicitTask`/`resolveNextTask`/`pullNextTask`) is pure
  brain PM and not reusable.
- `src/modules/agents/dispatch-loop.ts` — orchestration logic (semaphore, retry,
  delivery hookup) is generic in shape but hard-wired to `DeliveryOutcome`/
  `TaskStatus`/`updateTaskStatus` from the PM module; the `Semaphore` class
  itself (dispatch-loop.ts:57-78) is a trivial, fully generic lift.
- `src/modules/agents/coordinator.ts`, `prompt-builder.ts`, `prompt-templates.ts`,
  `template-renderer.ts` — templating is generic, but variable-building
  (`buildTemplateVariables`, `buildAgentDispatchContext`) pulls from PM task
  notes/routing/ownership; only the template *rendering engine* (placeholder
  substitution) is a clean lift.
- `delivery.ts`/`delivery-monitor.ts`/`delivery-review.ts`/`merge-stack.ts`/
  `fix-agent.ts`/`auto-merge.ts` — GitHub PR lifecycle automation layered on top
  of agent completion; not spawning per se, skip unless PR-automation reuse is
  also wanted.

**Bottom line for extraction**: lift `worktree.ts` + `data.ts` (agents table
schema/CRUD) + `completion-protocol.ts` (parser) + the argv/env-building half of
`spawnClaude` largely as-is; wrap the DB-touching parts of `handleProcessExit`/
`runDispatch` behind callbacks; treat `launch.ts` as the reference for the
interactive-mode `--agents`/`--mcp-config`/`--append-system-prompt` pattern
(no code copy needed, it's ~90 lines and already fairly generic). Skip the PM/
delivery/workflow layers entirely — they're brain's domain logic, not spawning
infra.
