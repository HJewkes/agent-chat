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
- `merge` builds its squash message with `titan-squash-message`.
- `queue` tries GNU `stat -c` before BSD `stat -f`, because GNU `stat -f` prints a filesystem
  report instead of failing, which broke the stale-lock age on Linux.

The `.bak-*` backups from the live `bin/` are not imported; they stay in the nightly archive.
Deleting them from the live `bin/` is an owner step after the cutover.

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
- `queue`, `log`: retire with TP-1570. Neither is named in the charter today, so they can
  probably go sooner.
- `task-note`: retires when `active-work task edit --append` is lock-safe.
- `scorecard`: no TS home. It stays until a TP task (TP-1537 or a new one) ports its rows.
