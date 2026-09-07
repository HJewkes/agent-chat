# Context and budget visibility for a running agent

An agent cannot see how full its own context window is. Claude Code knows; the MCP
subprocess does not, the transcript on disk records per-message usage but not the live
window, and no API answers "how full is that session". This note establishes exactly what
_is_ reachable, from where, and how agent-chat exposes it.

Everything below is from Claude Code **2.1.263** (`~/.local/share/claude/versions/2.1.263`,
`BUILD_TIME 2026-09-06T01:08:56Z`, `GIT_SHA 37ae3f38`). Field names are Claude Code's, and
a future build may change them without warning; the reader in `src/agents/budget.ts` is
tolerant by design for that reason.

## 1. What the status line is handed

The status-line payload is built by one function in the shipped bundle. It is the only
place a running session's live context fill leaves the process. Reconstructed from the
bundle, the payload is:

```
session_id            string          Claude Code's own session id
transcript_path       string
cwd                   string
session_name          string          optional
model.id              string          e.g. "claude-opus-5", "claude-opus-5[1m]"
model.display_name    string
workspace.current_dir / .project_dir / .added_dirs / .git_worktree? / .repo?
version               string
output_style.name     string
cost.total_cost_usd            number
cost.total_duration_ms         number
cost.total_api_duration_ms     number
cost.total_lines_added         number
cost.total_lines_removed       number
context_window.total_input_tokens     number   input + cache_creation + cache_read
context_window.total_output_tokens    number
context_window.context_window_size    number
context_window.current_usage          object   raw usage: input_tokens,
                                               cache_creation_input_tokens,
                                               cache_read_input_tokens, output_tokens
context_window.used_percentage        number
context_window.remaining_percentage   number
exceeds_200k_tokens                   boolean
prompt_cache.*                        object   optional; warm, ttl, expires_at, requests,
                                               misses, hit_ratio, cache_write_tokens,
                                               last_miss_cause, recache_tokens_if_cold, …
fast_mode                             boolean
effort.level                          string   only on models that take an effort setting
thinking.enabled                      boolean
rate_limits.five_hour.used_percentage / .resets_at        optional
rate_limits.seven_day.used_percentage / .resets_at        optional
rate_limits.spend_limit.used_percentage / .resets_at      gateway accounts only
vim.mode / agent.name / remote.session_id / pr.* / worktree.*   all optional
```

`resets_at` values are **unix seconds**. `used_percentage` is `utilization * 100`, so it is
already a percentage, not a fraction.

**On the sample.** I did not capture a live payload. Doing so means putting a tee into the
live `~/.claude/statusline-command.sh`, which the task forbids, and there is no other
process the payload passes through. The field list above is read out of the client's own
payload builder rather than guessed, which is the stronger source anyway, and two
independent checks corroborate it: the human's existing status line already parses
`.session_id`, `.context_window.*`, `.cost.*` and `.exceeds_200k_tokens` successfully, and
the synthetic payload below drives the real, unmodified status line to a correct render.
The verification step in §7 produces a genuine capture once the patch is applied.

Sample (synthetic, matching the shape above; no secrets appear anywhere in this payload —
the only identifier it carries is a session uuid and a cwd):

```json
{
  "session_id": "REDACTED-SESSION-UUID",
  "transcript_path": "/Users/REDACTED/.claude/projects/-Users-REDACTED-projects-agent-chat/REDACTED-SESSION-UUID.jsonl",
  "cwd": "/Users/REDACTED/projects/agent-chat",
  "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
  "workspace": {
    "current_dir": "/Users/REDACTED/projects/agent-chat",
    "project_dir": "/Users/REDACTED/projects/agent-chat",
    "added_dirs": []
  },
  "version": "2.1.263",
  "output_style": { "name": "Direct" },
  "cost": {
    "total_cost_usd": 2.5,
    "total_duration_ms": 120000,
    "total_api_duration_ms": 40000,
    "total_lines_added": 31,
    "total_lines_removed": 7
  },
  "context_window": {
    "total_input_tokens": 86000,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 1000,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 80000,
      "output_tokens": 1200
    },
    "used_percentage": 43.6,
    "remaining_percentage": 56.4
  },
  "exceeds_200k_tokens": false,
  "fast_mode": false,
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": { "used_percentage": 21.4, "resets_at": 1757300000 },
    "seven_day": { "used_percentage": 58.1, "resets_at": 1757600000 }
  }
}
```

## 2. How often the status line runs

More often than "on a timer", which matters: it is the sampling rate of everything here.

- On any change to **token usage**, permission mode, main-loop model, fast mode, effort,
  thinking, vim mode or PR status. Token usage changes after every API response, so in
  practice the status line runs at least once per assistant turn.
- On each new assistant message id.
- Debounced by **300 ms**, so a burst collapses into one invocation.
- On a periodic timer **only if** `statusLine.refreshInterval` is set in `settings.json`
  (seconds, minimum 1). It is not set on this machine, so there is no idle heartbeat.
- On a one-shot timer at the earliest rate-limit `resets_at` or prompt-cache expiry.

Consequence: a **busy** session republishes constantly; an **idle** one stops. A reading is
therefore never "current" by assumption, and `session_budget` reports age and a `stale`
flag rather than smoothing over it.

## 3. Usage and rate-limit signals

There are two different things, and they should not be conflated.

**Per session** — `cost.total_cost_usd`, `total_duration_ms`, `total_api_duration_ms`,
lines added/removed. Cumulative for that session only. Useful for attributing spend to a
task; useless for pacing against a quota.

**Per account** — the unified rate-limit windows. Claude Code reads these off response
headers `anthropic-ratelimit-unified-{5h,7d,7d_oi,overage}-{utilization,reset}` and keeps
them in memory, refreshed on every API call. It also polls `GET /api/oauth/usage`
(`?at_wall=1&skip_spend=1` in the at-wall case) for the same numbers. The four windows it
tracks are exactly:

| key                          | header segment | status-line name                     |
| ---------------------------- | -------------- | ------------------------------------ |
| `five_hour`                  | `5h`           | `five_hour` ("session limit")        |
| `seven_day`                  | `7d`           | `seven_day` ("weekly limit")         |
| `seven_day_overage_included` | `7d_oi`        | **not emitted**                      |
| `overage`                    | `overage`      | `spend_limit`, gateway accounts only |

The existing `~/.claude/scripts/rate-limits.sh` fetches `five_hour`/`seven_day` from
`/api/oauth/usage` with a 60 s file cache. **That call is now redundant**: the same two
windows are already in the status-line payload the script is reading on stdin. Removing the
`curl` would take a network round trip and a keychain read out of the status-line path. It
is not part of this change, but it is worth doing.

### The Fable budget

Claude Code's own display-name table for rate-limit types is:

```
five_hour                    "session limit"
seven_day                    "weekly limit"
seven_day_opus               "Opus limit"
seven_day_sonnet             "Sonnet limit"
seven_day_overage_included   "Fable limit"
overage                      "usage credit limit"
```

So a separate Fable budget exists and is named `seven_day_overage_included`. Three findings
follow, and the third is the one that matters:

1. It **is** collected locally. It is in the header-derived window set, so Claude Code holds
   a live `seven_day_overage_included` utilization and reset in memory.
2. It is **not** in the status-line payload. The payload builder copies `five_hour`,
   `seven_day`, and (gateway only) `overage`, and drops the other window. This is a
   deliberate three-key projection, not a bug in the parsing on our side.
3. It is **not** on disk anywhere. `rawUtilization` is in-memory process state; nothing
   persists it to `~/.claude`, `~/.claude.json`, `~/.claude/daemon/` or the status cache.

`seven_day_opus` and `seven_day_sonnet` are in the display table but _not_ in the collected
window set, so no per-model Opus or Sonnet utilization is available locally either.

**Therefore: the Fable budget cannot be exposed by any local source today.** The
`session_budget` shape below carries whatever windows the payload contains and nothing
else, rather than a `budgets: { default, fable }` shape with a permanently-null half.

What it would take, cheapest first:

- **Claude Code emits it.** One key added to the payload projection
  (`...co.seven_day_overage_included && { … }`). Nothing else on this machine changes and
  `session_budget` picks it up with no code change, because `rate_limits` is parsed as an
  open map. This is the right ask; it belongs upstream as a feature request.
- **Poll `/api/oauth/usage` ourselves** and look for a `seven_day_overage_included` key in
  the body. I could not confirm the response shape: the endpoint returned
  `429 rate_limit_error` on both attempts, because the human's status line already polls it
  every 60 s. Confirming this is one clean `curl` at a quiet moment. If the field is there,
  a small cached fetch in agent-chat closes the gap without touching Claude Code — at the
  cost of a keychain read and a network call agent-chat does not currently make.
- **Scrape the string from Claude Code's own UI.** Rejected: it appears only in warning
  banners, so it is absent exactly when usage is low and everything is fine.

### The status-line pill for the Fable budget

Not written, because there is nothing to render. The pill would be four characters next to
the existing rate-limit bars and the patch is trivial; the blocker is entirely the missing
data. Once a `rate_limits.seven_day_overage_included` key appears in the payload, the change
to `~/.claude/statusline-command.sh` is: add `.rate_limits.seven_day_overage_included.used_percentage // "unknown"`
to the single `jq` call at line 52, run it through the existing `pct_to_bar` / `pct_to_color`
helpers, and append one more bar character to `pill3` beside `${bar_5hr}${bar_weekly}`. No
new process, no new cache, no new failure mode. I have deliberately not shipped a patch
that renders a bar for a number that is always `unknown`.

## 4. Options for exposing this to an agent

**(a) Status line writes a per-session file; agent-chat serves it as a tool.**
Latency: one file read, sub-millisecond. Token cost: zero until asked. Staleness: bounded
by how often the observed session redraws, and reportable. Works for **peers**, not just
self, because the registry already carries every session's `claudeSessionId`. Cost: a
one-line change to a file agent-chat does not own, and a reading only exists for sessions
that have a status line configured.

**(b) A hook (`UserPromptSubmit` / `PostToolUse`) injects a budget line into context.**
Latency: zero, it is already there. Staleness: none. But it costs tokens on **every** turn
whether or not the agent cares, it can only ever describe the session it runs in (so a
planner still cannot see its peers), and it makes the number a thing the agent is told
rather than a thing it can choose to check. Hooks also cannot see the status-line payload;
the hook payload has no `context_window` field, so a hook would still need a written cache
to read from. That makes (b) a _renderer_ for (a), not an alternative to it.

**(c) An MCP resource.** Same data as (a) with a worse client story: resources are listed
and read by a different code path than tools, agent-chat exposes none today, and a model
that has never been told to list resources will not find it. The tool description is what
makes a capability discoverable.

**Recommendation: (a), implemented here.** It is the only option that answers for a peer as
well as for self, which is what a planner actually needs, and the only one that costs
nothing until it is called. (b) is worth adding **later**, reading the same file, if it
turns out agents do not check on their own — but that is a policy question to answer with
evidence, not up front, and it would burn tokens on every turn of every session to fix a
problem that may not exist.

## 5. What was built

- `src/agents/budget.ts` — the reader: `readBudget(sessionId)`, `parseBudget(raw)`,
  `formatBudget` / `budgetMiss`. Tolerant parser, explicit `stale` flag, `NOT_FOUND` with
  the reason and the path.
- `session_budget` MCP tool — `{ name? }`, omitted means self. Resolves a peer's session id
  the same way `chat_transcript` does: from the registry, which got it from that session's
  environment. Nothing is asked of any model and nothing new is published.
- `agent-chat agent budget [name]` — same reading from the CLI; with no name, every agent
  that has one, which is the planner's view.
- `scripts/session-budget-write.sh` — the writer. Reads the payload on stdin, writes an
  atomic per-session JSON, prunes files older than a day at most hourly, and exits 0 on
  every failure path.

Returned shape (the `json:` line of the tool output):

```json
{
  "session_id": "…",
  "cwd": "…",
  "model_id": "claude-opus-5",
  "written_at": 1757260000,
  "context": {
    "used_pct": 43.6,
    "remaining_pct": 56.4,
    "window_size": 200000,
    "input_tokens": 86000,
    "output_tokens": 1200,
    "cache_read_tokens": 80000,
    "cache_creation_tokens": 5000,
    "exceeds_200k": false
  },
  "cost": {
    "total_cost_usd": 2.5,
    "total_duration_ms": 120000,
    "total_api_duration_ms": 40000,
    "lines_added": 31,
    "lines_removed": 7
  },
  "rate_limits": {
    "five_hour": { "used_pct": 21.4, "resets_at": 1757300000 },
    "seven_day": { "used_pct": 58.1, "resets_at": 1757600000 }
  },
  "age_seconds": 1,
  "stale": false
}
```

`rate_limits` is an **open map**, not a fixed record. A build that starts emitting a fourth
window surfaces it here with no change on this side.

## 6. Pacing policy

Thresholds, not enforcement. Nothing in this change refuses an action; these are the
numbers the orchestration skill should quote so agents make the call themselves.

**Context.**

| reading             | what to do                                                                  |
| ------------------- | --------------------------------------------------------------------------- |
| < 60 %              | nothing. Do not check again for a while.                                    |
| 60–74 %             | finish the current unit of work. Do not start a new multi-file exploration. |
| **≥ 75 %**          | **teleport.** Write the handoff now, while there is room to write it.       |
| ≥ 85 %              | teleport immediately; a handoff written here is already degraded.           |
| `exceeds_200k` true | you are past the point where a compaction will preserve the plan. Teleport. |

75 % is the threshold because the handoff itself costs context, and a teleport brief worth
reading is not a two-line one. The failure this prevents is the one already on record in
this initiative: an agent that finished real work and could only report that it had no way
to deliver it.

**Account budget.**

| reading             | what to do                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `seven_day` < 70 %  | spend normally.                                                                |
| `seven_day` 70–85 % | do not spawn speculatively. One agent per task that is actually blocked on it. |
| `seven_day` > 85 %  | no new spawns for non-urgent work. Defer to after `resets_at`.                 |
| `five_hour` > 90 %  | do not start a long autonomous run; it will stall mid-way.                     |

Model choice: a Fable budget is **separate** from the Opus/Sonnet pool, so `seven_day`
pressure is not by itself a reason to avoid Fable profiles — and is not by itself a licence
to use them either, since the Fable window is invisible locally (§3). Until it is exposed,
treat "do not spawn fable profiles when weekly usage > X%" as **unenforceable** and say so,
rather than gating on a number that does not describe the budget being spent.

**How the orchestration skill should use this.** Reference these thresholds; do not
reimplement them. The skill should say: before `agent_spawn`, call `session_budget`; before
a long autonomous run, call `session_budget`; and quote the table above rather than a
number, so the threshold lives in one place. `stale: true` means the reading describes an
idle session and is evidence about the past — for a peer that is often exactly the
question, and for yourself it should not happen, because calling the tool means you are
mid-turn and your own status line has just run.

## 7. What the human must apply by hand

Nothing here touches `~/.claude` — both steps are yours to run. Neither is reversible by
this repo, and step 2 edits a live file.

**1. Install the writer.**

```sh
cp ~/projects/agent-chat/scripts/session-budget-write.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/session-budget-write.sh
```

**2. Add six lines to the status line.**

```sh
cd ~/.claude && patch -p1 --dry-run < ~/projects/agent-chat/scripts/statusline-session-budget.patch
cd ~/.claude && patch -p1 < ~/projects/agent-chat/scripts/statusline-session-budget.patch
```

The patch inserts this immediately after `input=$(cat)` at line 48 and changes nothing else:

```sh
# agent-chat: publish this session's context/rate-limit figures for session_budget.
# Guarded on the writer being installed, so removing the script disables this.
if [[ -x "$HOME/.claude/scripts/session-budget-write.sh" ]]; then
    printf '%s' "$input" | "$HOME/.claude/scripts/session-budget-write.sh" >/dev/null 2>&1
fi
```

The guard means step 2 is safe without step 1: with no writer installed the block is a
no-op. Uninstalling is `rm ~/.claude/scripts/session-budget-write.sh`; the status line then
behaves exactly as it does today without the patch being reverted.

**3. Confirm, and take the real capture §1 could not.**

```sh
ls -la ~/.claude/status-cache/sessions/          # one file per live session
jq . ~/.claude/status-cache/sessions/*.json      # the real payload, normalised
agent-chat agent budget                          # every agent with a reading
```

If `~/.claude/status-cache/sessions/` stays empty, the writer is not executable or `jq` is
not on the status line's `PATH`. The writer swallows both, by design — a status line that
errors is a status line that gets turned off.

### Verified before shipping

The patched script was driven with a real status-line payload and compared byte-for-byte
against the unmodified one: identical output with the writer absent, and identical rendering
with it installed under a scratch `HOME`, with the cache file written and read back through
`readBudget`. The end-to-end agreement between the shell writer and the TypeScript reader is
a test (`src/__tests__/budget.test.ts`), because those two field lists agree only by hand.
