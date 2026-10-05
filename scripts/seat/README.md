# Seat scripts

The bash and python scripts that seats run for merges, CI waits, pacing and scorecards. They
were kept outside git in the autonomy `bin/` directory. CC-746 brings them here so they get
history and CI-run tests, and then retires them one by one behind factory `land` and Shepherd.

`src/__tests__/seat-scripts.test.ts` runs each `test-*.sh` suite. `test-task-note.sh` drives
the real `active-work` CLI, so it runs only where `active-work` is on PATH, never in CI.

## The live copy is frozen

From this import until the `seat-merge` cutover, the live `bin/` copy is frozen. An emergency fix
lands in both places in the same change, with `diff -r <live bin> scripts/seat` in the PR body.

This copy differs from the live one on purpose, because the repository is public. Test temp
dirs and agent names are neutral (`seat-test-*`, `seat-9-*`). `premerge` has no built-in
coordinator list and exits 2 when `COORDINATORS` is unset, so the cutover must export
`COORDINATORS` in `seat-merge` before pointing it at this copy. `task-note` has no default data
root and exits 2 when `ACTIVE_ROOT` is unset. `queue` tries GNU `stat -c` before BSD `stat -f`,
because GNU `stat -f` prints a filesystem report instead of failing, which broke the stale-lock
age on Linux.

The `.bak-*` backups from the live `bin/` are not imported; they stay in the nightly archive.
Deleting them from the live `bin/` is an owner step after the cutover.

Until data paths are made location-independent, `queue`, `log`, `pace` and `scorecard` find
their data relative to their own directory. Do not run them from this checkout.

## Retirement list

- `merge-check`: first to retire. It has no caller, and Shepherd conflict-check and
  carry-merge cover it.
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
