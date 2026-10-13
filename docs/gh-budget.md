# Shared GitHub cooldown (gh-budget)

Agents call GitHub under one identity from many processes: the gh shim's passthrough, `gh pr create`,
and every write through `agent-chat gh-write`. `/rate_limit` never shows the secondary limit, so it
reported 5000 left while real calls got 403, and no pause fired (CC-1162). The gh-budget state gives
those processes one cooldown, so they stop calling into a limit that another process has already hit.

It is a cooldown only. There is no bucket and no budget sizing.

## Lanes and sources

A cooldown is per lane: `rest` or `graphql`. A REST cooldown leaves GraphQL open, and the reverse.
The lane comes from the call's shape (`src/gh-shim/call-shape.ts`), so `gh pr ...` is `graphql`
and `gh api repos/...` is `rest`.

Two sources are merged, and the later end wins per lane:

- **Observed.** The shim classifies every real-gh call it logs with `classify403`
  ([gh-calls](gh-calls.md)). A `secondary` or `primary` refusal on a call it answered or passed
  through records a cooldown. A 403 that names no limit (`unknown`) records nothing, since it may be a
  permission error. A hit is recorded as primary only when an `x-ratelimit-remaining: 0` header proves it.
  "API rate limit exceeded" in stderr alone is what the secondary limit says too, so without that header
  it is recorded as secondary.
- **Gateway.** Shepherd serve's `shepherd.ghBudget` RPC, `POST http://127.0.0.1:7410/rpc/shepherd.ghBudget`
  (override with `AGENT_CHAT_GH_BUDGET_URL`). The expected answer is
  `{"ok": true, "data": {"cooldowns": [{"lane": "rest", "until": <epoch ms or ISO>, "class": "secondary"}]}}`.
  The answer is cached for 10 s. Serve down, a timeout (500 ms), `ok: false` or an unknown RPC all read
  as no gateway cooldown and never block a call. That result is cached as well.

## Cooldown length

- **Secondary:** `max(retry-after, 60 s × 2^strikes)`, capped at 15 min.
- **Primary:** until `x-ratelimit-reset`. Without a future reset, it backs off as a secondary hit does.
- A refusal while the lane is still cooling can only extend the end. It never adds a strike, since it
  is the same incident seen again.
- A refusal within 15 min of the last cooldown's end adds a strike. A later one starts again at 0.

## What each caller does during a cooldown

- **Shim read** (GET, `view`, `list`, `status`, `checks`, `diff`, `watch`, `search`, or a GraphQL
  query that is not a mutation): it fails fast with exit 1 and no real-gh call. The message names the
  lane, the class, the source and the end time.
- **Shim write** (anything else): it passes through. Writes are meant to go through gh-write, which
  waits.
- **`gh api rate_limit [--jq <expr>]`:** the real body with each cooling lane spent: `remaining 0`,
  `used = limit`, and `reset` at the cooldown's end (`resources.core` and `rate` for REST,
  `resources.graphql` for GraphQL). Any other flags pass through to the real endpoint.
- **gh-write:** before each attempt it waits until both its spacing stamp and the lane's cooldown have
  passed. It reads the cooldown before taking its lock, so a slow gateway never holds the lock. Its
  `coreRemaining()` reads this state rather than `/rate_limit`. It answers 0 only while a proven primary
  limit cools the REST lane, so an ambiguous "API rate limit exceeded" gives up then and pauses otherwise.

`AGENT_CHAT_GH_SHIM_OFF=1` turns off the shim's gate along with its answers. Refusals are still
recorded.

## Files

Under `$XDG_STATE_HOME/gh-budget/` (default `~/.local/state/gh-budget/`):

| File            | Holds                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cooldown.json` | `{"rest": {"until", "class", "strikes"}, "graphql": {...}}`, the observed state. Each write replaces the whole file. |
| `cooldown.lock` | the directory lock around read-modify-write (`src/gh-budget/lock.ts`, shared with gh-write)                          |
| `gateway.json`  | `{"at", "cooldowns"}`, the last `shepherd.ghBudget` answer                                                           |

Code: `src/gh-budget/state.ts` (rules and file), `src/gh-shim/rate-limit.ts` (gate, gateway,
`rate_limit` answer), `src/cli/gh-write.ts` (gh-write's reads).
