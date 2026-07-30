# agent-chat demo walkthrough

A live runbook for sanity-checking what's shipped so far. Read it, drive it by hand,
and note anything that feels off — this is a review tool, not documentation of intent.

## Setup

agent-chat is installed at **user scope** (`~/.claude/plugins/installed_plugins.json`,
`agent-chat@agent-chat-local`), so any Claude Code session on this machine already has
the `mcp__plugin_agent-chat_agent-chat__*` tools available — no per-project opt-in.

Open **two** terminal Claude Code sessions in the same repo checkout (any repo works;
a real one makes the `cwd`-containment and worktree steps meaningful). Call them
**A** and **B** throughout. Each step below says which pane to type it into, as a
plain-language instruction — these are MCP tools, not CLI commands, so you drive them
by asking Claude to do the thing, not by typing a command yourself.

Everything here is phrased as "In A, say: ...". Type that sentence (or close to it)
into the session named.

---

## 1. Presence — register, status, list

**In A**, say: `Register yourself on agent-chat as "alice", working on "demo walkthrough".`
→ uses `chat_register`. This is the one call every session should make first; nothing
else works until a session has a name.

**In B**, say: `Register yourself as "bob", working on "reviewing alice's demo".`

**In A**, say: `List the registered sessions.` → `chat_list`. You should see both
`alice` and `bob`, each with `observed` fields (git branch, worktree path) the server
derived itself, not anything either session typed.

**In B**, say: `Set your status to blocked, with dnd on, and declare {"role": "reviewer"}.`
→ `chat_status`. Then **in A**, `chat_list` again — bob should now show `blocked`,
`dnd: true`, and the declared `role` label, distinguished from the observed fields.

---

## 2. Messaging — send, broadcast, ask, notify, endorse, inbox

**In A**, say: `Send bob a message: "starting the demo, say hi back".` → `chat_send`.
Bob receives it as a `<channel source="agent-chat" ...>` block on its next turn —
fire-and-forget, no reply channel back to A automatically.

**In B**, notice the incoming message, then say: `Send alice a message back: "hi,
ready".` Confirm **A** sees it.

**In B, with dnd still on from step 1**, have **A** send bob another message. It should
queue rather than interrupt — **in B**, say `Check your inbox` (`chat_inbox`) to pull
it manually. Turn dnd back off in B before continuing (`chat_status` again).

**In A**, say: `Broadcast: "anyone free to sanity-check something?"` → `chat_broadcast`.
Every other registered session gets it — with two sessions this just proves it reaches
bob, but note in the report that this is O(sessions) and meant to be used sparingly.

**In A**, say: `Notify the human: "demo walkthrough is halfway done".` → `chat_notify`
— lands in your human's queue, no reply expected. Compare against `chat_ask`
(**in A**, say: `Ask the human: "should I keep going past step 5?"`) which actually
blocks on an answer — use this one to feel the difference: notify doesn't wait, ask does.

`chat_endorse` needs a peer claiming human authority to relay to another peer — skip
unless you want to specifically test the provenance-marking path; it's a narrower,
higher-stakes tool than the others here.

---

## 3. Tags and subscriptions

**In A**, say: `Tag bob with "owner:demo".` → `chat_tag`. **In B**, `chat_list` should
show the tag with attribution (who applied it, when) — tags are peer-applied and
logged, not self-asserted the way `declared` fields are.

**In A**, say: `Subscribe to sessions tagged "owner:demo" joining or leaving.` →
`chat_subscribe` with scope `tag`. Then **in B**, register a third session (or exit
and re-register) — A should get a join/leave notice without asking.

**In A**, say: `Unsubscribe from everything.` → `chat_unsubscribe` with no arguments,
confirm it drops all rules cleanly.

**In A**, say: `Read bob's recent activity without messaging it.` → `chat_activity` —
a pure read, costs bob nothing. Compare against `chat_transcript` (**in A**, say:
`Read the last 10 turns of bob's transcript`) — deeper, structured, and also free to
the observed session.

---

## 4. Agent teams — spawn, profiles, list, logs, surface, background, teleport

**In A**, say: `List the available agent profiles.` → `agent_profiles`. Note what each
one grants and denies — this matters for the escalation-guard step below.

**In A**, say: `Spawn a headless explorer agent named "scout" to look for TODO comments
in this repo.` → `agent_spawn` with `profile: explorer`. **In A**, say `List agents` →
`agent_list` — scout should show up as a durable peer with lifecycle state.

**In A**, say: `Pull scout into a visible terminal.` → `agent_surface`. Watch it
actually open a pane. Then **in A**, say: `Send scout headless again.` →
`agent_background` — note this only works on *yourself*, so you'd actually run this
one from within scout's own session if you want to see it self-background.

**In A**, say: `Show scout's denied-tool log.` → `agent_logs` — should be empty for a
well-behaved explorer; if scout tried something outside `Read`/`Grep`/`Glob` this is
where it shows up (with the caveat that a tool never granted at all leaves no trace
here — call that out explicitly if you're checking permission boundaries).

Skip `agent_teleport` unless you specifically want to watch a session hand off to a
successor build — it ends the current session, which makes it disruptive mid-demo.

---

## 5. Safety — escalation guard, cwd containment, spawn depth

**Escalation guard (CC-39 / CC-40).** From **scout** (the explorer you just spawned,
profile denies `Bash`/`Write`/`Edit`), try: `Spawn a peer-profile agent named
"shell-buddy".` It should **refuse**, citing tools scout was never granted (CC-39,
allow-side). This is the sharpest live check available: a read-only agent asking for
a shell-capable peer, denied at the one enforcement point that matters.

CC-40 (deny-side) needs a custom profile with the same `allowedTools` as scout but a
weaker `disallowedTools` to trigger — not naturally reachable with the four builtin
profiles, so it's covered by the regression test in `supervisor.test.ts` rather than
this live walkthrough. Worth noting in your sanity-check pass rather than reproducing
by hand.

**cwd containment.** **In A**, say: `Spawn an explorer with cwd set to your home
directory` (i.e. somewhere no registered session is working). It should refuse:
"must be at or under a directory some session is working in."

---

## 6. Wrap-up

**In A and B**, exit both sessions (or explicitly deregister) and confirm nothing is
left dangling — `agent_list` from a third session should show scout as exited, not
hung.

Report back anything that: refused when it should have allowed, allowed when it
should have refused, or gave a message that didn't match what actually happened.
