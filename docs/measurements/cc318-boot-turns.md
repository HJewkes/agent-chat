# CC-318: boot turns before and after `seats boot`

Measured 2026-10-11 from a worktree build of main at dadff80, over the transcripts under
`~/.claude-profiles/*/projects/*/*.jsonl`. The question: did `agent-chat seats boot` (ac#259
d151d74, ac#260 816c792; named by the charter from 2026-10-02) cut the boot work of a seat
generation by at least 50%?

## Method

Command, run from the worktree after `npm run build`:

```sh
node scripts/boot-turns.mjs --day 2026-09-29 --day 2026-09-30 --day 2026-10-03 --day 2026-10-09
node scripts/boot-turns.mjs --day 2026-09-29 --day 2026-09-30 --day 2026-10-03 --day 2026-10-09 --json
```

A generation is a transcript whose first record falls on the day (UTC) and whose first prompt names a
seat (`Register as <seat> with chat_register`, `You are <seat> (TELEPORT`, or `Run the autonomy charter
… as seat <seat>`; `SEAT_PATTERNS` in `src/agents/seats/boot-turns.ts`). Its window is the first 10 API
turns, deduplicated by `message.id`, with sidechain records skipped. A turn is a **boot turn** when at
least one of its tool calls is in BOOT_CLASS:

- `Read` of a path matching `/autonomy\/(seats|queues?|logs)\/|charter\.md|decisions\.md/`
- `ToolSearch`
- an MCP tool ending in `chat_inbox`, `chat_list`, `session_budget`, `agent_list` or `chat_register`
- `Bash` whose command matches `/agent-chat (seats (boot|status)|agent ls)|aw (task list|list)/`

`seats boot` itself counts as a boot turn on purpose: the claim was that one such turn replaces several.
USD is the list price of the 10-turn window (`priceRequest` from `@titan-design/session-analytics`).
Before = 09-29 and 09-30 (before the 10-01 rebuild put `seats boot` live). After = 10-03 and 10-09
(full days after the 10-02 charter change). Every generation reached 10 turns, so none was dropped as
short.

## Results

| day        | seat          | generations | mean boot turns | mean USD (10 turns) | used `seats boot` | unmentioned post-handoff ids |
| ---------- | ------------- | ----------- | --------------- | ------------------- | ----------------- | ---------------------------- |
| 2026-09-29 | titan-coord   | 17          | 4.41            | 0.798               | 0%                | -                            |
| 2026-09-29 | voltras-coord | 17          | 4.29            | 0.815               | 0%                | -                            |
| 2026-09-29 | total         | 34          | 4.35            | 0.807               | 0%                | -                            |
| 2026-09-30 | titan-coord   | 13          | 4.92            | 0.925               | 7.7%              | -                            |
| 2026-09-30 | voltras-coord | 2           | 3.00            | 0.753               | 0%                | -                            |
| 2026-09-30 | total         | 15          | 4.67            | 0.902               | 6.7%              | -                            |
| 2026-10-03 | titan-coord   | 13          | 4.54            | 0.783               | 100%              | f870a039, 37ba7da1, 9821a087 |
| 2026-10-03 | voltras-coord | 4           | 4.50            | 0.770               | 100%              | -                            |
| 2026-10-03 | total         | 17          | 4.53            | 0.780               | 100%              | f870a039, 37ba7da1, 9821a087 |
| 2026-10-09 | titan-coord   | 4           | 4.75            | 0.766               | 100%              | -                            |
| 2026-10-09 | total         | 4           | 4.75            | 0.766               | 100%              | -                            |

Pooled over generations:

| period               | generations | mean boot turns | mean USD (10 turns) |
| -------------------- | ----------- | --------------- | ------------------- |
| before (09-29/09-30) | 49          | 4.45            | 0.836               |
| after (10-03/10-09)  | 21          | 4.57            | 0.777               |
| change               |             | +2.7% (a rise)  | -7.0%               |

Per seat, titan-coord went from 4.63 (30 generations) to 4.59 (17), and voltras-coord from 4.16 (19)
to 4.50 (4). No seat fell by anything close to 50%.

Which boot-state calls fill the window (mean turns per generation that make at least one such call; a
turn can make several, so the rows sum past the boot-turn mean). Counted by a one-off scratch pass with
the same window and BOOT_CLASS, not part of `scripts/boot-turns.mjs`:

| call                      | before | after |
| ------------------------- | ------ | ----- |
| `ToolSearch`              | 1.98   | 2.00  |
| `chat_register`           | 1.00   | 1.00  |
| `chat_inbox`              | 0.94   | 0.81  |
| `agent-chat agent ls`     | 1.16   | 0.38  |
| `session_budget`          | 0.76   | 0.05  |
| Read seat, queue or log   | 0.63   | 0.19  |
| Read charter or decisions | 0.51   | 0.19  |
| `agent-chat seats boot`   | 0      | 1.00  |
| `agent-chat seats status` | 0.06   | 0.48  |

## Verdict

**NOT MET.** The bar was a fall of at least 50% in mean boot turns within the first 10 turns. Boot turns
rose 2.7% (4.45 to 4.57); list-price USD of the window fell 7.0%.

`seats boot` did replace what it was built to replace: roster, budget and file reads fell by about 2.3
turns per generation. But it costs a turn of its own, seats added a `seats status` call on half the
generations, and the two fixed costs it does not touch dominate: **`ToolSearch` (about 2 turns per
generation, unchanged)** and `chat_register` (1 turn, unchanged). Together they are 3 of the 4.5 boot
turns. A further cut needs those, for example loading agent-chat's deferred tool schemas without a
`ToolSearch` turn, or folding registration into the boot command.

The amended check (0 unhandled post-handoff messages) is also not met: on 10-03 one titan-coord
generation was shown three post-handoff ids (f870a039, 37ba7da1, 9821a087) that it never mentioned again.
"Unmentioned" means the id string never reappears in a later turn, so a message handled without quoting
its id also counts here.

## Caveats

- **Generation counts.** The plan's rough grep (about 37, 33 and 23 seat transcripts on 09-29, 10-03 and
  10-09) counted every file mentioning a seat or `seats boot`, which includes the seats' workers. Checking
  the undetected transcripts on all four days for seat-style first prompts found one missed seat:
  `tp-ram-1003`, an owner-attended ad-hoc titan-platform seat with 4 generations on 10-03, whose prompt
  (`You are tp-ram-1003, the owner-attended seat …`) matches no `SEAT_PATTERNS` form. It is not a
  charter coordinator seat, so it is left out rather than patched in. No titan-coord or voltras-coord
  prompt was missed.
- **Small after sample.** 10-09 has only 4 titan-coord generations and no voltras-coord generation on
  this machine. The verdict does not hinge on it: 10-03 alone (17 generations, 4.53) is also above the
  before mean.
- **Not like for like.** The charter text and handoff prompts changed between the periods, beyond the
  `seats boot` line. That is why the per-call table is given: it shows where the turns went.
- Transcript text is not recorded here; only counts, seat names and message ids.
