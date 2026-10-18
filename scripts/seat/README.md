# Seat scripts

The bash and python scripts that seats run for merges, CI waits, pacing and scorecards. They
were kept outside git in the autonomy `bin/` directory. CC-746 brings them here so they get
history and CI-run tests, and then retires them one by one behind factory `land` and Shepherd.

`src/__tests__/seat-scripts.test.ts` runs each `test-*.sh` suite. `test-task-note.sh` drives
the real `active-work` CLI, so it runs only where `active-work` is on PATH, never in CI.

## Cutover

CC-1019, CC-1020 and CC-1021 move the seats from the live autonomy `bin/` copy to this one. Until
then, an emergency fix lands in both places in the same change, with `diff -r <live bin>
scripts/seat` in the PR body. After the cutover this copy is canonical, `log` and `task-note`
included, and the autonomy `bin/` copies retire via CC-1021.

`seat-merge`, and anything else that runs these scripts, must export:

- `SEAT`: the seat name `merge` writes into the squash message.
- `COORDINATORS`: the space-separated coordinator seat names. `premerge` has no built-in list and
  exits 2 without it.
- `ACTIVE_ROOT` (the active-work data root) or `AUTONOMY_ROOT` (the autonomy directory, default
  `$ACTIVE_ROOT/claude-channels/sources/autonomy`). `queue`, `log`, `pace` and `scorecard` find
  their data there, `scorecard` and `task-note` read tasks under `ACTIVE_ROOT`, and each exits 2
  without a root.
- `AGENT_CHAT_HOME`, where it is not `~/.agent-chat`. `premerge` and `scorecard` read
  `events.db` there, and `pace` reads `seat-watchdog.json` and `pace.json`.
- `titan-squash-message` on `PATH` (or `SQUASH_MESSAGE_BIN`). `merge` fails rather than fall back
  to GitHub's default message.

These values come from `~/.config/titan/seat.env`, which chezmoi manages, so this public repo
holds no site values.

This copy differs from the live one on purpose:

- Test temp dirs and agent names are neutral (`seat-test-*`, `seat-9-*`), because the repository
  is public.
- `premerge` requires `COORDINATORS`, and `task-note` requires `ACTIVE_ROOT`, instead of
  built-in site defaults.
- `queue`, `log`, `pace` and `scorecard` require a root instead of falling back to their own
  parent directory.
- `premerge` reads a verdict whose body opens with a code fence (CC-842).
- `premerge` refuses a PR whose Shepherd run carries an `owner-asked` hold, and fails closed
  unless `titan-factory` on PATH answers with a timeline or "not registered" (TP-2439).
- `merge` builds its squash message with `titan-squash-message`.
- `queue` tries GNU `stat -c` before BSD `stat -f`, because GNU `stat -f` prints a filesystem
  report instead of failing, which broke the stale-lock age on Linux.

The `.bak-*` backups from the live `bin/` are not imported; they stay in the nightly archive.
Deleting them from the live `bin/` is an owner step after the cutover.

## Queue verbs

`queue <seat> <verb>` edits `queues/<seat>.md` under a lock, refuses a write that would take
the file over 5,000 bytes, and reports the new size on stderr. Run it with no arguments for the
full usage.

- `replace <old> <new> [<old> <new>...]`, or `replace -` with `<<<` / `===` / `>>>` blocks on
  stdin: exact text swaps. Each old must match once; nothing is written unless every pair does.
- `set <KEY> <text...>`: rewrite one item, sub-lines included, keeping its marker.
- `add [--top] <section> <text...>`, `done <KEY> [--pr N]`, `park <KEY>`, `move <KEY> <section>`.

KEY is the item's leading id (`TP-487`) or `<section>:<n>` for a numbered item (`morning:208`).

`agent-chat seats boot` prints an `edit:` line under the queue section with `AUTONOMY_ROOT` and
the absolute path of this script, so a seat can run it as printed. The line is left out when
the install has no `scripts/seat/queue`.

## Backlog

`backlog` keeps seat plan questions outside the 5,000-byte queue cap (CC-760, CC-765): one YAML
record per question in `<autonomy>/backlog/<seat>/<id>.yml`, while the queue keeps a numbered
one-line pointer such as `131. tc-131 (one-way): <decision>. backlog/seat-a/tc-131.yml`.
It needs `node` and the `yaml` package from this checkout's `node_modules`.

| Field                        | Content                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | `tc-131` or `tc-130.2`: at most 3 lowercase letters, a number, an optional dotted sub-id                                             |
| `seat`, `initiative`, `task` | Owning seat; initiative and task id (`CC-760`) that `task-note` writes to                                                            |
| `decision`, `now`            | What is being decided, in one sentence; the current value or behaviour, or `none`                                                    |
| `options[]`                  | `{key, proposed}`, at least two; `proposed` is the proposal text, never a bare heading                                               |
| `trade_off`                  | Cost of each option that is not recommended                                                                                          |
| `door`, `why_owner`          | `two-way` or `one-way`; a one-way door needs the charter section 10 reason                                                           |
| `recommended`                | `{option, reason}`; `option` is one of the keys                                                                                      |
| `opened_at`                  | ISO time that starts the 12 h clock; `add` stamps it when the draft has none                                                         |
| `visual`                     | `null` or `{captures: [{key, file, label}]}`; `file` is a relative path under `<id>/img/` beside the record, with no `..` or symlink |
| `pr`                         | Optional `{url, summary, gate_reason}`, all three                                                                                    |
| `links`, `blocks`            | Optional lists of references                                                                                                         |
| `status`                     | `open`, `deferred`, `decided`, `escalated`, `answered` or `closed`                                                                   |
| `resolution`                 | `{by, answer, comment, cite, confidence, at}`, written by `resolve`                                                                  |
| `deferred_until`             | Set on a Defer; `due` reopens the record after it                                                                                    |

- `add <seat> <file>`: lint, copy the record and its captures into place, set `open`.
- `lint <file...>`: print each rule a record breaks; exit 1 if any record fails.
- `list [<seat>] [--status S]`: one tab-separated line per record.
- `due`: reopen deferred records past `deferred_until` with the clock restarted, then print the
  path of every `open` two-way record at least 12 h old. One-way records never appear. The seat
  puts the list in the decider brief.
- `resolve <id> --by decider --answer K --cite C --confidence X` sets `decided`; with no
  precedent the decider runs `resolve <id> --escalate --answer K --rationale R` (`escalated`).
  Both append a line to the task's notes through `task-note`.
- `close <id>`: move the record to `<seat>/closed/` and run `queue <seat> done <id>`.

The root is `AUTONOMY_ROOT`, else `$ACTIVE_ROOT/claude-channels/sources/autonomy`; with neither,
`backlog` exits 2. `BACKLOG_NOW` overrides the clock, and `BACKLOG_TASK_NOTE` and `BACKLOG_QUEUE`
override the sibling scripts, for tests.

## Retired

- `merge-check` (CC-1031): replaced by Shepherd's conflict check and carry-merge
  (titan-platform `products/factory` shepherd `merge-up-carry.ts`).

## Retirement list

- `ci-wait`: retires when TP-1539 and TP-1587 land and the charter stops naming it. Factory
  `waitForCi` and Shepherd own CI waits.
- `merge` + `premerge`: retire together when break-glass `seat-merge` retires (CC-599, Shepherd
  as the normal merge path; TP-1626 decides whether premerge grows or Shepherd absorbs the
  case). `seat-merge` retires with them.
- `pace`: retires when CC-742 lands and the charter says "read `agent-chat seats status`".
- `log`: retires now that charter section 10 names `agent-chat seats log <seat> "<text>"`
  (CC-1058), which stamps the line with the machine clock. Removal itself stays with CC-1021 /
  TP-1570.
- `queue`: stays while seats keep a queue file. `agent-chat seats boot` names it (below).
- `backlog`: stays beside `queue`, and retires with it when TP-1570 moves seat queues.
- `task-note`: retires when `active-work task edit --append` is lock-safe.
- `scorecard`: no TS home. It stays until a TP task (TP-1537 or a new one) ports its rows.
