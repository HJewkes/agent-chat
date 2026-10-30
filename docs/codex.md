# agent-chat on Codex

Codex starts agent-chat's MCP server the way Claude Code does, but it renders no channel
push. What has shipped:

- **S1.** The server detects a Codex host (`AGENT_CHAT_HOST=codex`, or a parent process
  named `codex`), registers it as `codex:<hostPid>@<host>`, and serves instructions that
  make no `<channel>` claim.
- **S2.** Every push to a Codex host is also written to a spool keyed on the Codex pid,
  `<state>/codex-hosts/<hostPid>/inbox`. `chat_inbox` clears what it returns, and the
  directory goes when the server exits.
- **S3.** A hook that tells the model what waits in that spool (below).
- **S4.** `agent-chat codex run`, a supervisor that delivers that spool into the thread,
  waking an idle session (below).

## S3: the inbox notice hook

`agent-chat inbox-hook --host codex <post|prompt|stop>` reads the spool of its parent
process, which is the Codex process that runs the hook.

- **A notice, never a body.** Codex puts hook context in the developer role, which ranks
  above the user, so peer text must not go there. The hook prints the count, the senders
  and "call chat_inbox". The bodies arrive as `chat_inbox` tool output. A sender name is
  reduced to letters, digits and `._:@-`.
- **Each record is noticed once.** `post` and `prompt` print only when a record arrived
  since the last notice. Each record's notice is claimed with an exclusive create, so when
  parallel tool calls fire concurrent hooks only one prints it. Nothing is claimed out of
  the spool itself, so `chat_inbox` still returns every message.
- **Stop blocks once per turn.** `stop` blocks the turn end while anything waits, even if a
  tool hook already noticed it. It never blocks when Codex sets `stop_hook_active`, so the
  turn always ends.
- **A retired identity is silent.** When `AGENT_CHAT_AGENT_ID` names an identity that a
  teleport superseded, the hook prints nothing.
- **It never fails the tool call.** Any error means no output.

Add this to `~/.codex/config.toml` yourself, then trust the hooks when Codex asks:

```toml
[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "agent-chat inbox-hook --host codex post"
timeout = 10

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "agent-chat inbox-hook --host codex prompt"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "agent-chat inbox-hook --host codex stop"
timeout = 10
```

Limits:

- An idle session is not woken. The hook covers a busy session and its turn end only.
- A multi-thread app-server host, such as the desktop daemon, shares one Codex pid across
  its threads, so this spool key is ambiguous there. Use `chat_inbox` on such a host.
- The pid key holds only if the hook command runs as a direct child of Codex. A wrapper
  script that forks instead of `exec`ing breaks it.

## S4: `agent-chat codex run`

`agent-chat codex run [--name <name>] [--resume <thread>] [--wake-cap <n>] [--codex <path>]
[codexArgs...]` starts `codex app-server` and owns one thread on it. Arguments after the
options go to `codex app-server`.

- **Its own MCP server.** The supervisor passes `-c` overrides that run agent-chat's MCP
  server under the app-server with `AGENT_CHAT_HOST=codex`, so that server spools (S2).
  Nothing in `~/.codex/config.toml` needs to change for it.
- **`--name`.** The name goes into that server's env as `AGENT_CHAT_NAME`, and the server
  registers under it at startup, before any turn, so peers can address the session by
  name. The name follows the agent-name rule (lowercase letters, digits, `-` and `_`). If
  another session holds it, the server registers under a name derived from the directory,
  as it does without `--name`.
- **`AGENT_CHAT_HOME`.** Codex passes MCP children only a short allowlist of variables, so
  the supervisor sets this one in that server's env. Without it the server would join the
  default broker while the supervisor watched another home's spool.
- **Delivery.** The supervisor watches the spool of its own Codex. Records go in as one
  user-role text input per drain, in arrival order, under a header saying they come from a
  peer and not the user. While a turn runs they go in as `turn/steer` on that turn. When
  the session is idle they start a new turn. If the turn ended before the steer arrived,
  they start a new turn instead. A record leaves the spool only after the RPC succeeded;
  on any other error it goes back for the next drain.
- **Idle wake is uncapped by default** (decision 511). Every record that arrives while the
  session is idle starts a turn, and each such turn costs one model turn.
- **`--wake-cap <n>`** allows at most `n` idle wakes per rolling hour. Over the cap,
  records wait in the spool, and the next wake the cap allows carries them all. A busy
  turn is still steered. When the cap trips, the broker posts one line from `agent-chat`
  to the session's spawner: a message to the agent that spawned it, or a notice in the
  human's queue for a session the human started. When no broker is running, or no
  session is registered from that Codex, the line goes to stderr instead.
- **Approval policy `never`.** The thread is started or resumed with
  `approvalPolicy: "never"`. The supervisor declines every request the app-server sends
  it, so an approval prompt would fail the tool call it gates.
- **Exit.** The supervisor exits with the app-server's exit code, or 128 plus the signal
  number when a signal ended it. SIGINT and SIGTERM are forwarded to the app-server.

## S6: the live wake probe

`AGENT_CHAT_LIVE=1 node scripts/codex-listen-live.mjs` runs the real `codex` binary under
`agent-chat codex run`, against a mock Responses server, with a scratch HOME, `CODEX_HOME`
and `AGENT_CHAT_HOME`, and with hooks trusted only in the scratch home. Run `npm run build`
first. It exits non-zero if an assertion fails.

| Assertion      | Pass means                                                                                                | Basement, codex-cli 0.162.1                  |
| -------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Idle wake      | Within 10 s the marker reaches the model under the peer header, with a `UserMessage` in the rollout       | PASS, about 4.7 s                            |
| Mid-turn steer | The marker is in the request after the tool output; `sleep 20` exits 0; one turn ran                      | PASS                                         |
| No duplicate   | With the S3 hooks on, the marker is once in model input, as user; the hook's developer notice has no body | PASS                                         |
| Spool key      | Under the npm node wrapper, the supervisor finds `codex-hosts/<native pid>` through the real parent chain | PASS                                         |
| Failure path   | With the app-server killed, records stay in the spool and the supervisor exits non-zero                   | **FAIL**: exit 137, but the spool is deleted |

Findings from the run:

- **Records are lost when the app-server dies.** The supervisor returns its claims to the
  spool and logs that it did, but the MCP server's exit handler then removes
  `codex-hosts/<pid>`, so they are gone. Whether a resumed supervisor could recover them
  from there is UNVERIFIED: it has a new pid.
- **The first message took about 4.7 s.** The spool dir does not exist until the first
  record, so the likely cause is the 5 s rescan. That cause is UNVERIFIED.
- **Hook trust is separate under `app-server`.** `--dangerously-bypass-hook-trust` is not
  accepted after `app-server`, and hooks do not run when it is given before it. The probe
  writes `hooks.state` from what `hooks/list` reports instead.

Not run: the Mac half, because Mac spawns are not wired, and a real-model run, which needs
owner approval.
