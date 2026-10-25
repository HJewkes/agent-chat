# Seat policy (`seat-policy.json`)

CC-1580. The owner's file naming which seats get root authority and which profiles they may spawn
by name. Without it, nothing changes: coordinator depth and the CC-39/40 tool checks apply as before.

## What a listed seat gets

A seat the file lists, held by a process the broker itself launched under that seat's name, is a
root coordinator (coordinator depth 0) whose spawns are limited to a **ceiling**: a strict list of
profile names. This holds across a watchdog relaunch, a resume, a teleport and a move to another
account. A session that only registers the seat's name gets nothing.

A requester is the root of seat `S` only when all of these hold:

- its registry entry was bound by a launch, not by a session id or an adoption;
- the entry's name is `S`;
- its own spawn row has target `S`, and is a spawn or a teleport successor;
- the row's profile is in `seats.S.launchProfiles`;
- `seats.S.root` is `true`.

A policy seat name launched with a profile outside `launchProfiles` is not root. It runs under
today's rules, the spawn result warns, and a `seat_root_denied` event is logged.

## The file

Path: `$AGENT_CHAT_HOME/seat-policy.json` (default `~/.agent-chat/seat-policy.json`). Schema v1:

```json
{
  "version": 1,
  "seats": {
    "example-seat": {
      "root": true,
      "launchProfiles": ["example-coordinator"],
      "ceiling": ["example-worker", "example-reviewer", "example-coordinator"]
    }
  }
}
```

| Field                         | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `version`                     | Must be `1`. Any other value makes the file invalid.               |
| `seats`                       | Object keyed by seat name.                                         |
| `seats.<name>.root`           | Must be `true`. An entry without it grants nothing and is dropped. |
| `seats.<name>.launchProfiles` | Profiles a launch of the seat may use and still be root.           |
| `seats.<name>.ceiling`        | Profile names the root seat may spawn. Matched by name only.       |

Unknown keys are ignored and logged once (`seat_policy_ignored`).

## Fail-closed rules

Any of these makes the broker treat the file as granting no seats (`seat_policy_invalid` is logged
once; an absent file is silent):

- the path is a symlink or not a regular file;
- it is owned by a uid other than the broker's;
- its mode is group- or world-writable (`mode & 0o022`);
- the JSON is malformed, `version` is not `1`, `seats` is not an object, or a root seat's
  `launchProfiles` or `ceiling` is not a list of non-empty strings.

The check runs on the open descriptor too, so a swap between the stat and the read is caught.

The file is read on every request and cached on its stat, so editing or deleting it takes effect on
the seat's next spawn request with no broker restart. A ceiling profile whose file changed since
broker start (CC-1094 drift) is refused whatever `profileDrift` says, because the ceiling trusts the
profile by name. A profile outside the ceiling is refused with a reason naming the policy file.

## What the tools show

- `agent_list` marks a row `root seat (seat-policy.json)` when its name is listed, its profile is in
  `launchProfiles`, and it is a spawn or teleport successor. The roster does not carry how the
  connection registered, so this is a display of the policy; the broker decides each spawn on the full proof.
- `agent_profiles`, called by a session whose registered name is a listed seat and whose live row
  qualifies, appends the seat's ceiling.

## Owner steps

Agents must not write this file, and nothing needs them to.

1. **Add the settings deny rule** to the user settings of every Claude config dir that agents run
   under (`~/.claude/settings.json` and each `~/.claude-profiles/*/settings.json`):

   ```json
   "permissions": { "deny": [
     "Edit(~/.agent-chat/seat-policy.json)",
     "Write(~/.agent-chat/seat-policy.json)",
     "Bash(*seat-policy.json*)"
   ] }
   ```

   leak-guard protects the path on the code side; this rule is the settings-side half.

2. Create the file, then `chmod 0644` it and confirm it is not a symlink and that you own it.
3. Run `agent-chat doctor` and expect `seat-policy ok (1 root seat: example-seat)`.
4. Restart the broker in a planned window (the binding and ceiling code need it; the file does not).
5. Verify: have the seat spawn one worker and one coordinator. Both succeed, and the child rows in
   `events.db` show `seat_ceiling: example-seat` and `coordinator_depth: 1`.
