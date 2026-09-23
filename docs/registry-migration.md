# Migrating the MCP tools and CLI onto `@titan-design/registry` (CC-106)

Status as of 2026-09-23: slice 1 converted `chat_list`, `chat_send` and `agent retire`; `agent_resume`
and `agent resume` were born as registry commands after it. Slice 2 converts the reads that fit
0.2.0 as-is: `agent_profiles`, `agent_list`, `agent_background`, `agent_surface`, `chat_inbox`,
`chat_activity`, `agent_logs`, `chat_transcript` and `session_budget`, and deletes `boundedLimit`.
13 tools and about 31 CLI verbs still use the hand-written path, and both paths run side by side.

## Why

`src/server/tools.ts` checks every tool argument by hand with helpers such as `requireString`. The
MCP SDK does not enforce the published `required`, `enum`, `anyOf` or `maxItems`, so the schema a
model sees and the checks a handler runs are two separate things to keep in step. The
`requireString` comment records a case where they drifted: a model left out `text`,
`String(undefined)` became the word "undefined", and a peer received it. Registry derives both the
published JSON Schema and the argument parse from one zod schema, so that mismatch cannot be
written.

## Fit assessment (registry 0.2.0, read from the published `dist/`)

Registry exports `defineCommand` and `createRegistry`. It also has `invokeCommand`, which validates
arguments, runs the command, and returns a JSON envelope without throwing. For MCP it has
`commandToTool`, and for commander it has `commandPath`, `positionalSpec`, `optionFlagSpec`,
`collectOptionParser` and `collectCliArgs`. It peers on zod 4, and agent-chat was on zod 3.25, so
slice 1 upgrades zod. The MCP SDK accepts either version.

Each of agent-chat's harder requirements, checked against those exports:

| Requirement                                           | Result                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Descriptions survive byte for byte                    | Fits. `description` passes through unchanged. zod's `.describe()` carries parameter descriptions.                                                                      |
| Handlers get the `BrokerClient` and the caller's name | Fits. `Command<Args, Result, Ctx>` takes a product context that extends `BaseContext`. `ToolHandler` builds a `ToolContext` for each call.                             |
| Refusals are returned, not thrown                     | Fits. A refusal is an ordinary `run` result. Only a throw becomes an `ok: false` envelope, which `invokeTool` rethrows so the server still renders `Error: <message>`. |
| `to` is a string or up to 8 strings                   | Fits. `z.union` emits the same `anyOf`. Array bounds are declared with `.meta()`, so the published schema keeps its keys and the over-cap refusal text stays in `run`. |
| JSON Schema that Claude Code accepts today, unchanged | Partial. See gaps G1 and G2. G1 has a product-side adapter in `server/command.ts`.                                                                                     |
| CLI help and argv unchanged                           | Partial. Positionals and boolean flags fit. Value placeholders, variadics and defaults do not (G4 to G6).                                                              |

**The largest finding is structural.** Almost no MCP tool and CLI verb are the same command defined
twice. The tools act as the calling session: they need its registration, and they answer in model
prose. The CLI verbs act as the human, who holds no registration, and they print operator text or
text relay parses. `send` issues `human_send`, while `chat_send` issues `send`. `agent ls` and
`agent_list` render different rosters, and `profiles`, `agent budget` and `agent surface` each
differ from their tool twins in either output or identity. Merging a pair into one `defineCommand`
would change one surface's output. The migration therefore keeps two projections, `server/command.ts`
and `cli/command.ts`, over one set of argument schemas (`src/args.ts`) and one wire protocol. It
does not try to derive each verb from a tool.

## Gaps: what registry needs

Per the shared-code rule in `CLAUDE.md`, none of these is patched by copying registry code into
agent-chat. G1 has a product-side adapter that is deleted when the release lands. The rest block the
slices that need them.

- **G1. `commandToTool` must emit the input-side schema.** 0.2.0 calls `toJSONSchema(cmd.args)` in
  zod's default output mode, which closes every object with `additionalProperties: false`. No
  hand-written tool declares that, and zod's `z.object` strips unknown keys rather than refusing
  them, so the emitted schema also misstates the parse. Needed signature:
  `commandToTool(cmd: AnyCommand, naming: ToolNaming, options?: { io?: 'input' | 'output' }): McpToolDescriptor`,
  with `'input'` as the default. The adapter today is `toolDefinition` in `src/server/command.ts`. It
  strips only the root, which is enough for every tool without a nested object.
- **G2. `commandToTool` needs a JSON Schema override hook.** `chat_register` and `chat_status`
  publish `declared` as `{type: 'object', additionalProperties: {type: 'string'}}`. `z.record` adds
  `propertyNames`, and `z.object().catchall()` adds `properties: {}`, so neither reproduces it.
  Needed signature: `options.override?: z.core.ToJSONSchemaParams['override']` on the same third
  argument, passed through to `toJSONSchema`. This blocks slice 5.
- **G3. `invokeCommand` needs a formatter for invalid arguments.** 0.2.0 fixes the message as
  `Invalid arguments: <path>: <message>; ...`. Needed signature:
  `InvokeOptions.formatInvalidArgs?: (issues: readonly z.core.$ZodIssue[]) => string`. Without it,
  a call that zod rejects shows the old wording behind that prefix. This is the one visible change
  in slice 1 (see Invariants). It does not block any slice.
- **G4. `CliOption.valueName?: string`.** `optionFlagSpec` always renders `--x <value>`. The help
  text relay and humans read says `--config-dir <path>`, `--briefing <slug|auto>`,
  `--since <id|now|all>`, `-p, --port <port>` and `-n, --lines <n>`. This blocks those verbs in
  slice 8.
- **G5. Variadic positionals.** `positionalSpec` renders an array field as `<text>`, not `<text...>`.
  `answer <id> <text...>`, `send <to> <text...>` (relay), `debug send` and
  `agent spawn <name> <profile> [brief...]` (relay) need `<name...>` / `[name...]` for array-typed
  fields. This blocks slice 8.
- **G6. Option defaults in help.** `watch --since` (default `now`), `--interval` (`2`) and
  `service logs -n` (`50`) print `(default: ...)` in help. Needed signature:
  `optionDefault(cmd: AnyCommand, key: string): unknown`, which reads the field's zod `.default()`
  so the product can hand it to commander. This blocks slice 8.
- **G7 (nice to have). Positional labels.** `approve <id> <allow|deny>` renders correctly only if
  the zod field is literally named `allow|deny`. `CliMeta.labels?: Record<string, string>`, honoured
  by `positionalSpec`, would let the field be `behavior`. This blocks nothing.

A command projected onto both surfaces would also need `CliMeta.description` and `CliMeta.path`,
because MCP descriptions are long prompts and tool names differ from CLI paths. Given the
structural finding above, no slice needs them, so they are not requested.

## Inventory

### MCP tools (25; `*` = required)

| Tool               | Defined at                                | Arguments                                                                                                                              | CLI twin?                                     | Handler depends on                                                             |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `chat_register`    | `src/server/tools.ts:211`                 | `name*`, `working_on`, `declared` (string record)                                                                                      | none                                          | broker `register`, host identity, git observation, **sets** the name           |
| `chat_status`      | `src/server/tools.ts:238`                 | `status*` (enum), `working_on`, `dnd` (bool), `declared`                                                                               | none                                          | broker `status`                                                                |
| `chat_list`        | `src/server/commands/chat-list.ts`        | none                                                                                                                                   | `debug ps` differs in output                  | broker `list`, budget cache on disk; **converted**                             |
| `chat_claim`       | `src/server/tools.ts:268`                 | `patterns` (string[], 24 max, empty = whole worktree), `worktree_path`                                                                 | none (`debug claims` only reads)              | broker `claim`                                                                 |
| `chat_release`     | `src/server/tools.ts:301`                 | `worktree_path`                                                                                                                        | none                                          | broker `release`                                                               |
| `chat_send`        | `src/server/commands/chat-send.ts`        | `to` (string or 1..8 strings), `to_tag`, `text*`, `in_reply_to`; one of `to`/`to_tag`                                                  | `send` is `human_send`, a different verb      | broker `send`, registration guard; **converted**                               |
| `chat_tag`         | `src/server/tools.ts:317`                 | `target`, `add` (string[]), `remove` (string[]), tag rules, 16 max                                                                     | none                                          | broker `tag`, registration guard                                               |
| `chat_activity`    | `src/server/commands/chat-activity.ts`    | `name*`, `limit` (number, 15 default, 50 cap)                                                                                          | none                                          | broker `activity`; **converted**                                               |
| `chat_broadcast`   | `src/server/tools.ts:363`                 | `text*`                                                                                                                                | none                                          | broker `broadcast`, registration guard                                         |
| `chat_ask`         | `src/server/tools.ts:377`                 | `text*`                                                                                                                                | none (`answer` is the other side)             | broker `ask`, registration guard                                               |
| `chat_endorse`     | `src/server/tools.ts:391`                 | `to*`, `text*`                                                                                                                         | `endorse` approves, the other side            | broker `endorse`, registration guard                                           |
| `chat_notify`      | `src/server/tools.ts:419`                 | `text*`                                                                                                                                | none                                          | broker `notify`, registration guard                                            |
| `chat_inbox`       | `src/server/commands/chat-inbox.ts`       | `limit` (number, 10 default, 50 cap)                                                                                                   | `inbox` is the human queue, different         | broker `inbox`; **converted**                                                  |
| `chat_subscribe`   | `src/server/tools.ts:441`                 | `scope*` (enum), `target` (needed for name/tag), `kinds` (enum[])                                                                      | none                                          | broker `subscribe`                                                             |
| `chat_unsubscribe` | `src/server/tools.ts:471`                 | `scope` (enum), `target`                                                                                                               | none                                          | broker `unsubscribe`                                                           |
| `agent_spawn`      | `src/server/tools.ts:484`                 | `name*`, `profile*`, `brief*`, `surface`/`isolation`/`inherit` (enums), `cwd`, `worktree`, `owns` (string[]), `config_dir`, `briefing` | `agent spawn` has other flags and output      | broker `spawn`, registration guard, `CLAUDE_CONFIG_DIR`                        |
| `agent_teleport`   | `src/server/tools.ts:587`                 | `handoff*`, `model`                                                                                                                    | `teleport abort` is the veto, different       | broker `teleport`, registration guard                                          |
| `agent_surface`    | `src/server/commands/agent-surface.ts`    | `name*`                                                                                                                                | `agent surface`: same frame, different text   | broker `surface`; **converted**                                                |
| `agent_resume`     | `src/server/commands/agent-resume.ts`     | `name*`, `message`, `surface` (enum)                                                                                                   | none                                          | broker `resume`; **converted**                                                 |
| `agent_background` | `src/server/commands/agent-background.ts` | none                                                                                                                                   | none                                          | broker `background`, registration guard; **converted**                         |
| `agent_profiles`   | `src/server/commands/agent-profiles.ts`   | none                                                                                                                                   | `profiles`: different layout                  | profile files on disk, no broker; **converted**                                |
| `agent_list`       | `src/server/commands/agent-list.ts`       | `include_retired` (bool)                                                                                                               | `agent ls`: different roster, relay parses it | broker `agents`, budget cache; **converted**                                   |
| `agent_logs`       | `src/server/commands/agent-logs.ts`       | `name*`, `limit` (number, 10 default, 20 cap)                                                                                          | none                                          | broker `agents`, transcript on disk; **converted**                             |
| `chat_transcript`  | `src/server/commands/chat-transcript.ts`  | `name`, `limit` (number, 12 default, 30 cap)                                                                                           | none                                          | own session id from env, or broker `agents`; transcript on disk; **converted** |
| `session_budget`   | `src/server/commands/session-budget.ts`   | `name`                                                                                                                                 | `agent budget`: lists all, different          | own session id from env, or broker `agents`; budget cache; **converted**       |

### CLI verbs (`src/cli/index.ts`)

| Verb                                          | Line    | Arguments and flags                                                                              | Relay depends on it                                 | Notes                                             |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| `inbox`                                       | 27      | none                                                                                             |                                                     | human queue                                       |
| `answer`                                      | 30      | `<id> <text...>`                                                                                 |                                                     | needs G5                                          |
| `dismiss`                                     | 36      | `<id>`                                                                                           |                                                     |                                                   |
| `approve`                                     | 42      | `<id> <allow\|deny>`                                                                             |                                                     | field named `allow\|deny` until G7                |
| `endorse`                                     | 48      | `<id>`                                                                                           |                                                     |                                                   |
| `service start/stop/status/restart/logs/open` | 61-95   | `-p, --port <port>` (custom parse), `-f`, `-n, --lines <n>` (default 50)                         |                                                     | needs G4, G6; launches the broker                 |
| `debug ps/claims/history [n]/log [n]`         | 99-110  | optional `[n]`                                                                                   |                                                     |                                                   |
| `debug send`                                  | 111     | `<to> <text...>`                                                                                 |                                                     | needs G5                                          |
| `watch`                                       | 116     | `<name>`, `--since <id\|now\|all>` (default), `--interval <seconds>`, `--once`                   |                                                     | needs G4, G6                                      |
| `agent ls`                                    | 127     | none; default subcommand                                                                         | **yes: parses rows**                                | convert with CC-107's JSON roster                 |
| `agent spawn`                                 | 134     | `<name> <profile> [brief...]`, `--briefing <slug\|auto>`, `--brief-stdin`, `--config-dir <path>` | **yes: argv, exit status, stdout or stderr reason** | needs G4, G5                                      |
| `agent retire`                                | 140     | `<name>`, `--force`                                                                              |                                                     | **converted**, `src/cli/verbs/agent-retire.ts`    |
| `agent worktrees`                             | 142     | `--prune`, `--force`                                                                             |                                                     |                                                   |
| `agent surface`                               | 148     | `<name>`                                                                                         |                                                     |                                                   |
| `agent budget`                                | 152     | `[name]`                                                                                         |                                                     |                                                   |
| `teleport abort`                              | 160     | `<name>`                                                                                         |                                                     |                                                   |
| `profiles`                                    | 165     | none                                                                                             |                                                     |                                                   |
| `doctor`                                      | 215     | none                                                                                             |                                                     |                                                   |
| hidden `send`                                 | 199     | `<to> <text...>`                                                                                 | **yes: argv, exit status**                          | needs G5                                          |
| hidden `ps`, `history [n]`, `log [n]`         | 196-198 | as the `debug` forms                                                                             |                                                     |                                                   |
| hidden `broker`, `mcp`, `run-agent <id>`      | 184-194 | process entry points                                                                             | launched by `broker-client.ts` and `plugin.json`    | **not converted**: launch contracts, not commands |

## Invariants every slice holds

1. **Tool names, descriptions, and the tools/list response are byte-identical.** Tool order is
   preserved because `TOOL_DEFINITIONS` puts `toolDefinition(tool)` where the literal used to be.
2. **Every call that fits the published schema answers byte-identically.** This covers reply text,
   refusal text, the broker frame sent, and failures thrown from `run` (`Error: <message>`).
3. **A call that does not fit the published schema is still rejected.** It is rejected before any
   frame is sent, and the error names the field. Until G3 lands, zod rejections show the old
   wording behind `Invalid arguments: <field>: `. Each slice's golden diff lists exactly those rows,
   and nothing else in the diff may change. Some wrongly typed optional values used to be dropped
   silently (for example `in_reply_to: 42`). They are now rejected, which is the bug class this
   migration removes.
4. **CLI help, argv, stdout, stderr and exit status are unchanged** for every verb, with extra care
   for the three relay parses: `agent spawn ... --brief-stdin`, `agent ls`, and `send`.
5. **No wire-protocol or broker change.** Every slice must be safe to merge and leave unreleased.
6. **No half-converted tool.** A tool is either entirely a registry command (schema, description,
   handler) or entirely hand-written. `ToolHandler.handle` routes registry names first.

## Test strategy

The goldens are captured before a slice converts anything and committed separately, so the PR shows
them passing before and after.

- `src/__tests__/mcp-golden.test.ts` pins the tools/list response as it leaves a real `Server`
  over an in-memory transport (`golden/tools-list.json`). It also pins pinned calls per tool
  (`golden/calls-<tool>.txt`): arguments, broker frame, and reply content. Before converting a
  tool, add its cases here: every reply branch, every refusal, and every rejection.
- `src/__tests__/cli-golden.test.ts` pins `helpInformation()` for every verb, hidden ones
  included (`golden/cli-help.txt`), and pinned invocations per verb (`golden/calls-<verb>.txt`):
  argv, frame, stdout, stderr, and exit status. The broker is mocked at `withBroker`.
- The golden files are excluded from prettier because they are byte captures.
- Each slice adds a schema-boundary test for its new required fields, like
  `registry-tools.test.ts`.
- The existing behaviour suites (`tags`, `presence`, `roster-budget` and the rest) stay unedited.
  They call `ToolHandler.handle` and do not care which path serves a tool.

## Slices

Sizes count definition and handler lines moved out of `tools.ts` or `cli/*`.

1. **Done in this PR.** Goldens, zod 4, the two projections, `chat_list`, `chat_send`,
   `agent retire`.
2. **Reads that fit 0.2.0 as-is.** `agent_profiles`, `agent_list`, `agent_background`,
   `agent_surface`, `chat_inbox`, `chat_activity`, `agent_logs`, `chat_transcript`,
   `session_budget`. Use `z.coerce.number()` for `limit`: it publishes `{"type":"number"}` and
   still accepts `"5"`, as `boundedLimit` does. About 350 lines.
3. **Human-queue writes.** `chat_broadcast`, `chat_ask`, `chat_notify`, `chat_endorse`. About
   150 lines.
4. **Claims, tags, subscriptions.** `chat_claim`, `chat_release`, `chat_tag`, `chat_subscribe`,
   `chat_unsubscribe`. These are arrays, enums, and the scope/target cross-field rule. About
   250 lines.
5. **Registration.** `chat_register`, `chat_status`. This needs G2 for `declared`. `ToolContext`
   also needs a session handle that can set the name, because `chat_register` renames the session.
   About 200 lines.
6. **Spawn and teleport.** `agent_spawn`, `agent_teleport`. These are the longest descriptions and
   the most-used spawn path. They fit 0.2.0, but they go last among the tools because they matter
   most. About 250 lines.
7. **CLI verbs that fit 0.2.0.** `inbox`, `dismiss`, `endorse`, `approve`, `debug ps`, `debug claims`,
   `doctor`, `profiles`, `agent surface`, `agent budget`, `agent worktrees`, `teleport abort`. About
   250 lines.
8. **CLI verbs blocked on G4 to G6.** `answer`, `debug send`, hidden `send`, `service *`,
   `watch`, `debug history/log`, hidden `ps/history/log`, `agent spawn`. About 400 lines.
9. **`agent ls`**, together with CC-107's versioned JSON roster, so relay moves off the prose in the
   same change that keeps the prose byte-identical.

When slice 6 lands, `tools.ts` keeps only the formatting helpers that more than one tool shares, and
the `requireString` family is gone.

## Rollout and rollback

Nothing reaches a live session until someone rebuilds. A running session keeps the MCP server it
started with, so a rebuilt `dist/` reaches a session only on its next start (a new session,
`/mcp` reconnect, or teleport). The CLI is different: after a build, the next `agent-chat`
invocation runs the new code, including relay's.

Slice 1 changes no broker, protocol, client or agent code. The one broker-adjacent effect is that
`agent-chat broker` enters through `cli/index.ts`, so a broker started from a new build also loads
zod 4 and registry at startup. It calls neither. Frames are unchanged, so any mix of old and new
MCP servers, CLI and broker works together during the rollout. No broker restart is required or
implied.

Rollback is to revert the merge commit and rebuild. There is no state, log or schema to migrate
back. Sessions that started on the new build keep it until they restart, and that is harmless
because the wire is unchanged.
