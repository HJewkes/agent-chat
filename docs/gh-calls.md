# gh-calls log (v1)

One JSONL line per GitHub call, so a day's API use can be read instead of estimated (TP-1172).
Writers: the gh shim, the burndown tick and session-miner. Shepherd's own calls
(`@titan-design/github`) are not logged; the tick's `rate-limit` lines bound their share.

## Where

`$XDG_STATE_HOME/gh-calls/<YYYY-MM-DD>.jsonl` (default `~/.local/state/gh-calls/`), one file per
UTC day. The first write of a day removes files older than 7 days. Writing is best effort: a call
never fails because its line could not be written.

## Line

```json
{
  "v": 1,
  "at": "2026-10-12T16:48:03.120Z",
  "caller": "shim",
  "api": "rest",
  "method": "GET",
  "route": "repos/{o}/{r}/pulls/{n}/files",
  "status": 200,
  "ms": 412,
  "remaining": 4210,
  "resource": "core"
}
```

| Field       | Meaning                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `v`         | Always `1`. Readers skip any other version.                                                                            |
| `at`        | ISO time the call finished.                                                                                            |
| `caller`    | Who made the call: the agent name for the shim (`shim` when unset), `burndown-tick`, `session-miner`, or `rate-limit`. |
| `api`       | `rest` or `graphql`.                                                                                                   |
| `method`    | HTTP method, upper case.                                                                                               |
| `route`     | The path with owner, repo and every number replaced and the query dropped: `repos/{o}/{r}/pulls/{n}/files`.            |
| `status`    | HTTP status, or `ok`/`error` from a caller that never sees one.                                                        |
| `ms`        | Wall time of the call.                                                                                                 |
| `remaining` | `x-ratelimit-remaining` when the call saw it, else `null`.                                                             |
| `resource`  | `x-ratelimit-resource` when the call saw it, else `null`.                                                              |
| `limit`     | Optional. `secondary` or `primary`, set by a writer that read GitHub's error text. The text itself is never stored.    |
| `limits`    | Only on `caller: "rate-limit"` lines: remaining per resource, e.g. `{"core":4100,"graphql":5000,"search":30}`.         |

The burndown tick writes one `rate-limit` line per tick from `gh api rate_limit`, which does not count
against the limit.

## Reading it

```
agent-chat gh-calls [--since 24h] [--top 5] [--json]
```

Prints the call count in the window, the top callers and top `method route` pairs, the newest
`rate-limit` reading, and refused calls (403 and 429) split by limit:

- **secondary**: the writer read a secondary-limit message, or the call had quota left (`remaining > 0`).
- **primary**: the writer read a primary-limit message, or `remaining` was `0`.
- **unknown**: refused with no headers and no classified message.

`rate-limit` lines are not counted as calls.
