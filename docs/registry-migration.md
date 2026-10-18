# Migrating the MCP tools and CLI onto `@titan-design/registry` (CC-106)

Status as of 2026-09-23: slice 1 converted `chat_list`, `chat_send` and `agent retire`; `agent_resume`
and `agent resume` were born as registry commands after it. Slice 2 converts the reads that fit
0.2.0 as-is: `agent_profiles`, `agent_list`, `agent_background`, `agent_surface`, `chat_inbox`,
`chat_activity`, `agent_logs`, `chat_transcript` and `session_budget`, and deletes `boundedLimit`.
Slice 3 converted the human-queue writes: `chat_broadcast`, `chat_ask`, `chat_notify` and
`chat_endorse`. Slice 4 converts `chat_claim`, `chat_release`, `chat_tag`, `chat_subscribe` and
`chat_unsubscribe`, and deletes `optionalTags`. Slice 6 converts `agent_spawn` and
`agent_teleport`; `optionalEnum` and `optionalPatterns` lose their last caller and are left for S5
to delete with `requireString` and `optionalString`, so only `chat_register` and `chat_status`
remain hand-written on the MCP side. Slice 7a converted the CLI human and debug reads: `inbox`,
`dismiss`, `approve`, `endorse`, `debug ps`, `debug claims`, `debug history [n]`,
`debug log [n]`, plus the hidden `ps`, `history [n]` and `log [n]` aliases, and added
`Report.errors` and `addVerb`'s `helpGroup`/`hidden` options. Slice 7b converted the remaining CLI
verbs that fit 0.2.0 as-is: `doctor`, `profiles`, `agent surface`, `agent budget [name]`,
`agent worktrees` and `teleport abort`; it also made `addVerb` return the mounted `Commander` so
`doctor lifecycle` stays attached as a subcommand. The CLI verbs blocked on G4-G6 (`answer`,
`service *`, `debug send`, `watch`, `agent spawn`, hidden `send`, `lifecycle backfill`) plus
`agent ls` (blocked on CC-107) still use the hand-written path, and both paths run side by side.
Slice S5 converts `chat_register` and `chat_status`, so every MCP tool is now a registry command and
`ToolHandler.handle` is a `TOOL_COMMANDS` lookup. `declared` publishes unchanged through
`declaredField` in `server/command.ts`, a product-side G2 adapter to delete when TP-171 ships. It
deletes `requireStatus`, `optionalDeclared`, `requireString`, `optionalString`, `optionalEnum` and
`optionalPatterns`.

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
| `chat_claim`       | `src/server/commands/chat-claim.ts`       | `patterns` (string[], 24 max, empty = whole worktree), `worktree_path`                                                                 | none (`debug claims` only reads)              | broker `claim`; **converted**                                                  |
| `chat_release`     | `src/server/commands/chat-release.ts`     | `worktree_path`                                                                                                                        | none                                          | broker `release`; **converted**                                                |
| `chat_send`        | `src/server/commands/chat-send.ts`        | `to` (string or 1..8 strings), `to_tag`, `text*`, `in_reply_to`; one of `to`/`to_tag`                                                  | `send` is `human_send`, a different verb      | broker `send`, registration guard; **converted**                               |
| `chat_tag`         | `src/server/commands/chat-tag.ts`         | `target`, `add` (string[]), `remove` (string[]), tag rules, 16 max                                                                     | none                                          | broker `tag`, registration guard; **converted**                                |
| `chat_activity`    | `src/server/commands/chat-activity.ts`    | `name*`, `limit` (number, 15 default, 50 cap)                                                                                          | none                                          | broker `activity`; **converted**                                               |
| `chat_broadcast`   | `src/server/commands/chat-broadcast.ts`   | `text*`                                                                                                                                | none                                          | broker `broadcast`, registration guard; **converted**                          |
| `chat_ask`         | `src/server/commands/chat-ask.ts`         | `text*`                                                                                                                                | none (`answer` is the other side)             | broker `ask`, registration guard; **converted**                                |
| `chat_endorse`     | `src/server/commands/chat-endorse.ts`     | `to*`, `text*`                                                                                                                         | `endorse` approves, the other side            | broker `endorse`, registration guard; **converted**                            |
| `chat_notify`      | `src/server/commands/chat-notify.ts`      | `text*`                                                                                                                                | none                                          | broker `notify`, registration guard; **converted**                             |
| `chat_inbox`       | `src/server/commands/chat-inbox.ts`       | `limit` (number, 10 default, 50 cap)                                                                                                   | `inbox` is the human queue, different         | broker `inbox`; **converted**                                                  |
| `chat_subscribe`   | `src/server/commands/subscriptions.ts`    | `scope*` (enum), `target` (needed for name/tag), `kinds` (enum[])                                                                      | none                                          | broker `subscribe`; **converted**                                              |
| `chat_unsubscribe` | `src/server/commands/subscriptions.ts`    | `scope` (enum), `target`                                                                                                               | none                                          | broker `unsubscribe`; **converted**                                            |
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
| `agent retire`                                | 140     | `[name]`, `--force`, `--finished`, `--spawner`, `--prefix`, `--dry-run` (CC-323)                 |                                                     | **converted**, `src/cli/verbs/agent-retire.ts`    |
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

## TP-617 candidate adapter checkpoint (2026-10-17)

Validation-only against reviewed registry b31fcb660dd5dc46a8023705d1c6f6c79446c965.
No published dependency or lockfile cutover is included. This remains partial TP-617;
published release, remaining CLI conversion and full verify are required.

The MCP projection now delegates schema controls to commandToTool. Explicit output
mode preserves the captured nested additionalProperties markers: input mode would
change agent_spawn/chat_send experiment and chat_ask option schemas. A root-only
identity override preserves the original open root; declared presentation uses an
instance-keyed override, retaining the exact null-tolerant product validator and
runtime caps. No new parser, serializer or authority is added.

CLI variadic rendering and placeholder readback now use registry directly. flagSpec
remains a temporary compatibility bridge for legacy embedded labels and required
literal switches. Its deletion requires the metadata conversion below; literal true
switches must keep bare-switch semantics. Remaining handwritten S8 verbs (answer,
service start/stop/status/restart/logs/open, debug send, hidden send, watch, agent
spawn, lifecycle backfill) and agent ls need separate original-behavior fixtures,
thin registry definitions and eventual deletion of their redundant mounting logic.
MCP and CLI identities/results stay distinct. No permanent fallback is complete.

Exact embedded-label metadata follow-up inventory at pinned45de964:

- src/cli/verbs/agent-budget.ts:28: spawner: { long: '--spawner <name>', description: 'only agents spawned by <name>' },
- src/cli/verbs/agent-budget.ts:29: prefix: { long: '--prefix <p>', description: 'only agents whose name starts with <p>' },
- src/cli/verbs/answers.ts:38: since: { long: '--since <msgId>', description: 'only rows after this msg_id: an ask, or a last next' },
- src/cli/verbs/answers.ts:39: limit: { long: '--limit <n>', description: `at most this many rows (default ${DEFAULT_LIMIT})` },
- src/cli/verbs/ask.ts:99: as: { long: '--as <label>', description: 'the label answers are read back under' },
- src/cli/verbs/ask.ts:101: kind: { long: '--kind <kind>', description: `one of ${QUEUE_ITEM_KINDS.join(', ')}` },
- src/cli/verbs/ask.ts:102: task: { long: '--task <id>', description: 'the task or gate the question is about' },
- src/cli/verbs/ask.ts:103: header: { long: '--header <text>', description: 'a one-line title for the queue, at most 80 chars' },
- src/cli/verbs/ask.ts:109: recommended: { long: '--recommended <option>', description: 'the option you recommend' },
- src/cli/verbs/ask.ts:110: default: { long: '--default <option>', description: 'the option taken if nobody answers' },
- src/cli/verbs/ask.ts:111: door: { long: '--door <door>', description: `${ASK_DOORS.join(' or ')}; absent is treated as one-way` },
- src/cli/verbs/ask.ts:112: category: { long: '--category <name>', description: 'decision category, e.g. tech_design' },
- src/cli/verbs/ask.ts:113: initiative: { long: '--initiative <slug>', description: 'the initiative the question belongs to' },
- src/cli/verbs/ask.ts:115: long: '--blocking <mode>',
- src/cli/verbs/ask.ts:118: reversible: { long: '--reversible <text>', description: 'one line on how to undo the answer' },
- src/cli/verbs/ask.ts:119: onNoAnswer: { long: '--on-no-answer <text>', description: 'what happens if nobody answers' },
- src/cli/verbs/burndown-classify.ts:255: long: '--ask <label>',
- src/cli/verbs/burndown-config.ts:287: const byOption = { long: '--by <who>', description: 'who is making the change; recorded in the settings log' }
- src/cli/verbs/burndown-config.ts:334: for: { long: '--for <duration>', description: 'how long the patch holds: 30m, 2h or 1d' },
- src/cli/verbs/burndown-config.ts:336: reason: { long: '--reason <text>', description: 'why, kept with the override' },
- src/cli/verbs/burndown.ts:510: long: '--apply <approved.json>',
- src/cli/verbs/burndown.ts:724: long: '--off-plan-ok <reason>',
- src/cli/verbs/gh-calls.ts:22: top: { long: '--top <n>', description: `how many callers and routes to list (default ${DEFAULT_TOP})` },
- src/cli/verbs/host.ts:28: long: '--host <name>',
- src/cli/verbs/port-send.ts:64: as: { long: '--as <sender>', description: `the sender label; only ${BURNDOWN_SENDER}` },
- src/cli/verbs/port-send.ts:69: task: { long: '--task <id>', description: 'the task a notice is about (with --notify)' },
- src/cli/verbs/teleport-request.ts:50: long: '--surface <surface>',
- src/cli/verbs/teleport-request.ts:54: long: '--to <machine>',

### Option-label candidate checkpoint

All28 declarations in the pinned inventory above now use bare long flags plus the
registry valueName field. The embedded-label formatting branch is deleted. Original
help and parse bytes are retained by the captured baseline fixture; no defaults,
coercion, broker semantics or S8 verb mounting changes are included.

The legacy literal-switch bridge is now deleted in the separate consumer follow-up,
using independently reviewed registry e063ec66's exact singleton-true handling.
addVerb calls optionFlagSpec directly; fieldSchema/schemaKind bridge imports are
removed. Original help, parse, MCP and port fixtures remain unchanged. This is
candidate validation only: published dependency adoption, full verify and remaining
S8 conversions still gate TP-617 completion.

### S8 human send candidate checkpoint

debug send and the hidden send alias now use one human_send registry action with
two CLI metadata projections. The hidden alias still has no source option. The
original handwritten debug.send implementation and its imports are deleted.
MCP chat_send remains a separate registered-session command.

The original18-case fakebroker fixture pins argv, frames, full stdout/stderr and
exit status, including blank strings, missing results, source validation and
broker errors. A numeric broker error remains legacy exit1, not its numeric code.
No live message or registration is performed by validation. Other S8 verbs and
published dependency adoption/full verify remain open under TP-617.

### S8 human answer candidate checkpoint

The answer CLI now mounts a registry verb over the existing unregistered human
broker request. The handwritten human.verdict function and its dead dismiss
branch are deleted after verifying answer was its sole caller. Human display
helpers remain. Plain string arguments, joined words, absent source option,
nullish refusal fallback (including an empty reason), output and legacy exit1
error behavior are retained.

A 15-case fixture was captured against the original e690 action before conversion
and reused unchanged afterward. It pins complete stdout/stderr, frames and process
status through a fake broker; validation sends no live message or registration.
Remaining S8 conversions, published dependency adoption and full verify still gate
TP-617 completion.

### S8 service logs candidate checkpoint

Service logs now uses a registry verb with its original parseInt policy in the
declared schema. NaN, prefixes, negative and zero counts retain their original
tail behavior. Only this mount opts into schema defaults through existing
optionDefault; every other mount retains its existing default behavior. The
handwritten logs action is deleted, with tailLines retained as a compatibility
reexport for original callers.

The 19-case original fake-file/controller fixture pins complete output, reads,
argv, exit status and help, including the numeric50 default, malformed counts,
missing/unreadable files and unsupported follow mode. No live log, service,
process or broker operation is used in validation. TP-617 remains open for other
S8 units, published dependency adoption and full verification.

### S8 service status candidate checkpoint

Service status now uses a registry report over the existing three-stage status
collector. The original collector and DTO remain available through compatibility
exports. Socket liveness alone determines success; PID/HTTP observations remain
diagnostic. The original port parsing policy is shared once with the remaining
service mounts. Partial stdout before a liveness error and legacy exit1 for
numeric broker errors are preserved.

The original 24-case fake-controller fixture pins probe order, explicit/meta/default
port precedence, full output and help, stale PID and rounding, parser failures
and partial error output. No live socket/HTTP/process/filesystem/broker or service
operation is used. Original help and other fixtures remain unchanged. Other S8
units, published dependency adoption and full verification still gate TP-617.

Status non-Error rejections use Node console formatting so structured rejection
fields remain visible. Two object-rejection cases captured against the original
action extend the unchanged24-case fixture; actual Console/Writable capture
checks prevent string-joining mocks from hiding this output difference.

### Human command rejection formatting

Answer, debug send and hidden send preserve Node console formatting for
non-Error rejections while retaining Error.message and exit1. Their existing
frames, options, successful output and refusal behavior remain unchanged.
Faithful real Console/Writable fixtures cover object/array and primitive errors;
57 full CLI cases retain the original33 cases unchanged. The whole original45de
source was overlaid for the baseline and every touched path restored exactly
before testing the formatting correction.

## Preserve natural success for the migrated one-shot commands

The original answer, service logs and socket-up service status actions return naturally. Their registry mounts opt out of immediate successful exit, allowing pending stdout and callbacks to finish and preserving an inherited process.exitCode. Their errors/refusals still exit immediately; debug and hidden send retain their original explicit exits and all other registry mounts keep their existing default.

A fake-only original/current process audit exposed successful truncation of an eight-MiB logs report. Regression tests now distinguish a natural return from explicit zero, cover the failure/default paths, and drain the actual built command helper through a real pipe with a late callback. No broker or service controller is invoked. This is source preparation under the reviewed registry candidate; published dependency adoption, full verification and the remaining imperative commands are still open.

The hidden stale-session-guard hook now declares its required agentId through the registry. Its existing lazy-loaded synchronous marker/output effect is unchanged and remains the only hook serializer. The mount preserves usage exit1, exact hook JSON or zero stdout bytes, natural success return and legacy rejection formatting. This declaration adds no broker, permission or teleport authority. Remaining imperative command migration and actual published dependency adoption are still open.

Agent listing now declares its existing options through the registry and mounts ls as the agent group's default child. Bare agent and explicit agent ls share that definition. The original listing effect still owns roster queries, filtering, budget/transcript reads and formatting; the adapter adds no output and preserves natural success and legacy refusals. The Commander default-child option is product-local; published dependency adoption and remaining command migration are still pending.

The leak-scan mount delegates its unchanged scanner to one registry definition. Its explicit completed-report mode assigns exitCode for clean/findings/cannot-pass results and returns naturally so output drains; parser and unexpected-invocation failures remain immediate. Published dependency adoption and full verification remain pending.

The service.open definition delegates the unchanged opener and returns naturally, preserving inherited exit status and its late error callback URL. Port parsing retains parseInt behavior; no actual browser launch or published adoption is qualified by the fixture.

The watch definition delegates the original polling loop, preserving defaults, initial cursor refusal, follow-mode retry and natural once completion. The fixture uses a fake broker and virtual sleep; it does not qualify live registration, channel wakeup or a real bus connection.
The pr-ready definition delegates the unchanged controller once, preserving its raw options, negated rebase flag, help and streamed output. Completed codes assign exitCode and return naturally; import and unexpected helper rejections retain immediate exit1. Owned fake-controller pipe fixtures qualify CLI adaptation, while selected original controller tests cover their owned Git and signal fixtures. Published dependency adoption, full verification and remaining lifecycle commands stay pending.

The hidden seat-blocks definition preserves natural success without changing an inherited exit code, and assigns a failed completed report's code while returning naturally. Its import failure remains immediate; helper, join and synchronous stdout failures retain the original caught String rendering. The product-local set-failure-code report mode adds no package API or hook authority. The original EventLog/report effect is unchanged; fixtures replace it in owned copies and do not exercise live seat state.

The three service control definitions preserve the original controllers byte-for-byte.
Their mounted Commander options retain the original parsePort and Number-based hold
parsers, including parse-stage error precedence and repeated-option behavior. Registry
delegation awaits each controller, keeps natural success and assigned exit codes, and
preserves legacy immediate exit1 with Console-equivalent nonError formatting. Owned-copy
fixtures replace the entire service module; no live daemon lifecycle is exercised.

### Hook declarations checkpoint

The hidden seat-hook and leak-guard pretool mounts now use product-local registry declarations. The existing hook effects remain unchanged and load only when their command runs; raw phase values, hidden help, import and effect failures, immediate failure exit, and natural success lifetime are preserved. Before conversion, the full copied CLI passed the same 61 small fake-hook cases twice and both hooks drained large backpressured stdout and stderr on natural return. These fixtures replace the entire hook modules and forbid real business IO, workers, child processes, and broker access. This checkpoint leaves 11 imperative CLI leaves; TP-617 remains open pending the remaining conversion and package release consumption.

### Agent spawn declaration checkpoint

The human agent.spawn mount now delegates through one registry declaration to the unchanged agentSpawn effect. Its two original Commander option parsers retain parse-stage precedence, while optional values, raw brief words, identity/account/host fields, explicit controller exits and legacy rejection formatting remain effect-owned. The original full copied CLI fixture captured 48 cases and passed unchanged twice before conversion; it replaces the entire agents module and forbids actual broker, provider, launch and stdin operations. A large-pipe test qualifies only the adapter when its synthetic controller returns naturally, not real spawn output before explicit exit. Ten imperative leaves remain after this checkpoint's acceptance; published dependency adoption and full TP-617 verification remain open.
