/**
 * The spawn kernel: the pieces of agent-runner machinery that are worth having
 * exactly one copy of, exported for a sibling project to import rather than
 * vendor.
 *
 * ## Why this file exists at all
 *
 * relay (R-3, the local agent-runner daemon) needs two things this repo already
 * paid for in live debugging:
 *
 * - `transcript.ts` — find and tail a running agent's transcript without
 *   holding its stdout pipe, including the lossy `projectSlug` derivation that
 *   was reverse-engineered from 27 real project directories.
 * - `denials.ts` — turn "the agent said it was blocked" into evidence, by
 *   matching a `tool_result` with `is_error: true` back to the `tool_use` that
 *   caused it. This is the difference between a red-team row that passes
 *   because a tool was *blocked* and one that passes because a model *declined*.
 *
 * Copying them would have created a second source of truth for facts about
 * another program's on-disk format — facts that have already moved once. So:
 * import, not vendor.
 *
 * ## Why the subpath resolves to TypeScript source, not `dist/`
 *
 * `dist/` is gitignored. A fresh clone of the consumer therefore cannot build
 * against a `dist/` that does not exist yet, which makes the dependency an
 * ordering problem between two repos' build steps — the kind that works on the
 * machine where it was set up and nowhere else. relay's daemon already runs
 * under `tsx`, so pointing the subpath at `.ts` sidesteps build order entirely:
 * there is nothing to build first.
 *
 * The cost, stated rather than discovered later: a consumer of
 * `agent-chat/spawn-kernel` must be able to load TypeScript. Plain `node` on
 * the built output cannot use this subpath. That is deliberate — anything here
 * needing to work from `dist/` should get its own condition in the exports map
 * at that point, not a silent second copy.
 *
 * ## What belongs here
 *
 * Only modules that are pure enough to cross a project boundary: filesystem
 * reads of another program's telemetry, no `agent-chat` state, no broker, no
 * config. Nothing that spawns. `run-agent.ts` in particular must never be
 * exported from here: it starts a process, and a module that crosses a project
 * boundary should not be able to.
 *
 * That rule used to be justified by `run-agent.ts` building
 * `env: { ...process.env }` — precisely what relay's threat model (T7/M8)
 * forbids. R-70 fixed that at the source (see `agents/agent-env.ts`), so the
 * justification is now the plainer one above: spawning is the thing, not the
 * environment it spawned with.
 */

export {
  findTranscript,
  observedModel,
  projectSlug,
  readTail,
  transcriptLine,
  transcriptPath,
} from './agents/transcript.js'
export type { Transcript } from './agents/transcript.js'

export { findDenials } from './agents/denials.js'
export type { Denial } from './agents/denials.js'

// Builds an argv and returns it — no env, no disk, nothing started — which is
// what lets a resume-with-message primitive cross the boundary while
// `run-agent.ts` stays behind it.
export { resumeWithMessage } from './agents/resume.js'
export type { ResumeCommand } from './agents/resume.js'
