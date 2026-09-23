# agent-chat

## Shared code: the titan-platform pattern

**Where shared code lives.** Reusable engine code lives in the titan-platform monorepo
(`~/projects/titan-platform`, `packages/*`), published to npm as `@titan-design/*`. Product
repos (active-work, agent-chat, relay, codewatch) are thin compositions over those packages.
The design system is separate: `~/projects/titan-design` publishes `@titan-design/react-ui`.

**Before building new functionality, ask three questions in order.**

1. Does a `@titan-design/*` package already do this? Read the package list in
   `titan-platform/README.md` and the package's own README. If yes, install it from npm.
   Never copy its source and never use a relative `file:` dependency.
2. Is it product-specific (this product's policy, vocabulary, or UI)? Then build it here.
3. Would a second product plausibly want it? Then build it in titan-platform as a package,
   or extend an existing one, release it through changesets, and consume the release here.
   File the package work as a TP task in the titan-platform initiative and link it from
   this initiative's task.

**When a package almost fits,** do not fork it locally. File a TP task naming the missing
export. Either wait for the release or build a product-side adapter that is deleted when
the release lands.

**Tier rule.** Packages depend only on lower tiers (0 primitives, 1 engines, 2 domain).
Products never depend on another product's source. They talk over a process boundary
(CLI, loopback HTTP, MCP).

**Extraction is not done until the source repo consumes the package.** An extraction that
leaves the original copy in place creates two diverging implementations. The swap-back is
part of the same task.

Full roadmap and evidence:
`active-work/titan-platform/sources/design-consolidation-roadmap.md` (2026-09-18).

**What this means for agent-chat (2026-09-18 audit).** agent-chat consumes no
platform engine package today. The owner decided it stays its own repo and becomes a thin
composition. Order: adopt `@titan-design/registry` for `src/server/tools.ts` and `src/cli/`;
build `@titan-design/agent-surface` from TP-51 and wrap `agents/surfaces/*` over it; add a
versioned JSON roster and lifecycle query for relay; then the TP-52 communication ledger;
and last, replace `supervisor.ts` with the TP-57 `agent-lifecycle` ledger (owner decision,
gated on start-reconciliation, a worktree-lease design, a handoff identity in
`agent-protocol`, and a tested rollback). Session registry, permission profiles, worktree
isolation, teleport, and plugin packaging stay here. Every broker-affecting step ships in
a planned restart window.

## Verify before opening a PR

CI runs Format first, then typecheck, then tests, and stops at the first failure. Run
all three locally, in this order, before `gh pr create`:

1. `npm run format:check` (fix with `npm run format`). Two of three sonnet PRs on
   2026-09-23 were red only on this step.
2. `npm run typecheck`.
3. `npx vitest run`. Not `npm test`: its `pretest` rebuilds `dist/` in the checkout
   the tests run in, and in the main checkout that swaps code under the live broker.
   In a fresh worktree run `npm run build` once first, because the live tests read
   `dist/`.

Never restart the broker from an agent; it serves every session on the machine.
