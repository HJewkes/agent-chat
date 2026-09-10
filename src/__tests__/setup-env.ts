/**
 * Strip the ambient session's identity out of the test environment (CC-55, CC-90).
 *
 * Most of this suite spawns the real CLI with `env: { ...process.env, ... }`, so
 * every variable the developer's own Claude Code session exports reaches the
 * servers under test. Two of them change behaviour:
 *
 * - `CLAUDE_CODE_SESSION_ID` is the guard `registerProvisionally` uses to decide
 *   whether it is a real session and may claim a name nobody asked for. Inherited,
 *   every harness server passes that guard and registers a phantom under a name
 *   derived from the checkout directory. The broadcast-budget case in
 *   `routing.test.ts` is where that surfaces: fanout cost is payload x recipients,
 *   so two extra phantoms push the FIRST broadcast over budget and the control
 *   half of the test fails. `server/index.ts` documents this as a known limit.
 * - `AGENT_CHAT_HOME` and the rest of `AGENT_CHAT_*` point a spawned server at the
 *   developer's live broker instead of the per-file temp home.
 *
 * Deleted here rather than in each spec because the leak is ambient: it is a
 * property of who ran `npm test`, not of any one file, and a fix that has to be
 * remembered per spawn is a fix that regresses. CI never had these set, which is
 * exactly why the failure only ever appeared locally.
 *
 * Tests that need either variable set it explicitly on their own env object
 * (`mcp-startup-live.test.ts`, `session-adoption.test.ts`, `turns.test.ts`), so
 * removing the ambient value leaves them unaffected.
 */
delete process.env.CLAUDE_CODE_SESSION_ID

for (const key of Object.keys(process.env)) {
  if (key.startsWith('AGENT_CHAT_')) delete process.env[key]
}
