# A4 — surfaces: what got built, and the seams left for A5/A6

## Shape

```
src/agents/surfaces/
  index.ts     surfaceFor(name, options) -> Surface     the only export callers need
  options.ts   SurfaceOptions, SurfaceRefused, the two injected function types
  command.ts   the fixed `agent-chat run-agent <id>` command, argv and shell forms
  headless.ts  detached child, ['pipe','pipe','pipe'], returns { surface, pid }
  iterm.ts     iterm-pane / iterm-tab / iterm-window, anchor search + fallback ladder
```

Surfaces are built per launch, not held as singletons: the anchor is presence data
belonging to one requesting connection, so a shared surface would let one
requester's spawn land in another's window.

## The seam the supervisor has to close (A6, not mine to write)

```ts
const surface = surfaceFor(plan.surface, {
  anchor: registryEntry.termSessionId,          // §5.4: the broker has none of its own
  onNotice: text => core.append({ kind: 'notice', ... }),
})
const handle = await surface.launch(plan)       // SurfaceRefused -> agent_spawn_refused
```

`{t:'register'}` already carries `termSessionId` in `protocol.ts`, but **the
registry does not store it on the entry yet**. That store, and the `spawn`
handler's lookup of it, are in `src/broker/**` — flagged rather than made.

`Surface.launch(plan)` takes only the plan (frozen in `types.ts`), so the anchor
and the notice sink are constructor options rather than launch arguments.

## Decisions taken where §5.4 left room

- **The returned `handle.surface` is the surface actually used, not the one
  requested.** After a fallback, `iterm-pane` returns `{ surface: 'iterm-window' }`.
  A handle describes a thing that exists; `paneRef` has to refer to the session
  that was really opened, or `agent attach` follows it to nothing.
- **A missing anchor is not a notice**, only a fallback. A closed anchor is both.
  The first is the ordinary case for any requester outside iTerm; the second means
  the human's window moved out from under the request and is worth a line.
- **`iterm-window` ignores an anchor entirely** — it never runs the search script,
  so it cannot fail to find one.
- **Refusal is a rejected `SurfaceRefused`**, a subclass so the supervisor can tell
  "cannot present here" apart from "AppleScript blew up". Both non-macOS and
  "iTerm2 not running" name `headless` in the message.
- **iTerm2 liveness is asked with `application "iTerm2" is running`**, never a
  `tell`, which would launch iTerm2 and drop a window on an unsuspecting desktop.
- **A surface is closed only by the thing that opened it** (CC-37). `launch`
  marks `ownsSurface` on a split, tab or window it created and leaves it off a
  pane it merely wrote into, and `Surface.close` refuses without that mark — so
  an anchor, or an adopted session's own window, is never closable from a bus any
  peer can reach. Teardown fires on `retire` and nowhere else: an exit is not an
  instruction to throw away what the agent printed. Closing a session covers all
  three surfaces, since iTerm2 closes the tab with its last session and the window
  with its last tab.

## The two §5.4 lessons, and how the tests pin them

1. The anchor is found by iterating windows/tabs/sessions for `unique ID`, matched
   against the UUID after the last `:` of `ITERM_SESSION_ID`. A test asserts the
   generated script does **not** contain `current window`.
2. Nothing here titles anything. A test asserts the script contains no `set name`
   and no fragment of `plan.title` — titling stays in `run-agent`'s OSC 0 write.

All three AppleScripts were verified live against iTerm2 3.x (a real split, a real
tab, a real window, plus the not-found path), then the suite was written against an
injected runner so it passes on any machine — 18 tests, no macOS required.

## Known gap, for A8

The headless child's stdout/stderr are piped and nobody reads them. That is what
§5.2 specifies and what stream-json needs, but until A8 attaches a reader a chatty
agent will block once the pipe buffer fills. A8 owns the drain.
