# The human queue on your phone: `agent-chat mirror` (CC-145)

`agent-chat mirror` copies the human queue into a Matrix room, `#queue`, and turns your
replies and reactions in that room back into verdicts on the local broker. You can answer
a `chat_ask`, approve an endorsement or allow a tool call from your phone. You do not need
to reach the terminal.

The mirror is a thin composition. `@titan-design/queue-mirror` owns posting, edits,
redaction and the verdict fold. `@titan-design/matrix-bus` owns the Matrix client. This
repo adds only the queue adapter (`src/mirror/source.ts`), the verb, the launchd job and
the doctor line.

## What it does

- **Tail.** It reads the broker's `/events` stream with `Last-Event-ID`, authenticated
  with `ui.token`. It reads the open set from `GET /api/queue`.
- **Post.** Each open `question`, `endorse_request`, `approval_request`, `notice`, and
  each `message` to `human`, is posted once to `#queue`. The post carries the full body
  and the same `msg_id` that `agent-chat inbox` prints.
- **Fold.** Your reply or reaction becomes a verdict over one **unregistered** socket
  connection. Because the connection is unregistered, the broker treats it as the human.
  Permissions never go over HTTP.
- **Edit.** When an item closes anywhere (phone, terminal, dashboard or expiry), the
  mirror edits the phone item to say so.

## Setup

1. **Config**: `~/.agent-chat/mirror.json`, mode 0600. It holds no secret; unknown keys
   are refused, so a token pasted here fails loudly.

   ```json
   {
     "homeserverUrl": "https://chat.example.org",
     "serverName": "example.org",
     "ownerUserId": "@owner:example.org"
   }
   ```

   Optional keys: `mirrorUserId` (default `@ac-<machine>:<serverName>`), `roomAlias`
   (default `#queue:<serverName>`) and `machine` (default `edge1`).

2. **Token**: `~/.agent-chat/mirror.env`, mode **0600**, one line:

   ```
   EDGE1_AS_TOKEN=<the appservice as_token>
   ```

   The mirror refuses to start if the file is readable by group or others. The token
   is read by `mirror run` only. It is never put in `process.env`, the plist or a log.

3. **Room**: the `#queue` bootstrap on the homeserver must invite the mirror user. A
   failed join shows up in `agent-chat doctor` as the last error.

4. **Start**: `agent-chat mirror start`. Add `--dry-run` first to see the plist and the
   `launchctl` calls without changing anything.

## Commands

```
agent-chat mirror start [--dry-run]  write the plist if absent or changed, enable, bootstrap, kickstart
agent-chat mirror stop               bootout and disable, so it does not come back at login
agent-chat mirror status             config, env file mode, launchd state, status freshness
```

`agent-chat mirror run` is hidden. launchd runs it, and a person does not need to.

The launchd job is `dev.hjewkes.agent-chat-mirror`, at
`~/Library/LaunchAgents/dev.hjewkes.agent-chat-mirror.plist`. It uses `KeepAlive` with a
30 s `ThrottleInterval`. Its log is `~/Library/Logs/agent-chat-mirror/mirror.log`, as
JSON lines. The job's environment is `HOME` and `PATH`, plus `AGENT_CHAT_HOME` when set.

State lives in `~/.agent-chat/mirror.db` (posted items, the source cursor and the `/sync`
token). A running mirror rewrites `~/.agent-chat/mirror.status.json` every 5 s.

## Verdicts

| Item on the phone  | ✅ or "yes" | ❌ or "no" | A text reply |
| ------------------ | ----------- | ---------- | ------------ |
| `approval_request` | allow       | deny       | —            |
| `endorse_request`  | approve     | dismiss    | —            |
| `question`         | —           | dismiss    | the answer   |
| `notice`           | dismiss     | dismiss    | —            |
| `message`          | dismiss     | dismiss    | —            |

Only the owner's events count. Your approval of an endorsement reaches the recipient
with `provenance="human-endorsed"` and `from` set to the composer, the same as
`agent-chat endorse`.

## The doctor line

```
ok    mirror             running pid 4242, synced 12s ago, 3 open on #queue:example.org
warn  mirror             not configured (~/.agent-chat/mirror.json absent)
warn  mirror             configured but not running (last error: ...)
warn  mirror             status 4m stale
FAIL  mirror             mirror.env is 0644; must be 0600
FAIL  mirror             the launchd plist contains the appservice token
```

The check reads files only. It makes no Matrix call and does not contact the broker.

## Failure modes

- **The broker is down.** The mirror never starts the broker, because a KeepAlive job
  would otherwise revive a broker someone stopped. It retries with backoff until the
  broker returns.
- **A mirror restart.** Nothing is lost. The source cursor and the `/sync` token are
  in `mirror.db`, and reconcile posts anything opened while the mirror was down. A reply
  you made while it was down is folded once.
- **The mirror was down for more than 500 rows.** The broker sends a reset. The mirror
  re-reads `/api/queue` and reconciles.
- **Expiry.** A relayed approval expires 10 minutes after it was raised, and its phone
  item is edited "expired". A headless agent's hook approval (CC-144) never expires,
  because the hook is still blocking.
- **Expired while the mirror was down.** The item is absent from `/api/queue`, so
  reconcile labels it "resolved at the terminal" rather than "expired". This is cosmetic.
- **A redacted or oversized item.** queue-mirror redacts secrets in approval previews
  and endorsement text, and it truncates anything over the size limit. Such an item
  cannot be resolved from the phone; answer it at the terminal.
- **What is not redacted.** Question, notice and message bodies, and an approval's tool
  description, go to the homeserver as written. Do not put secrets in a `chat_ask`.
- **A relayed approval whose session has gone.** The broker refuses the verdict. The
  phone item stays open until it expires, and the refusal is in the log.
