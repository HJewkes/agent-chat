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
