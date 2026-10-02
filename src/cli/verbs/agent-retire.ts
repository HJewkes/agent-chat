import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { RetirePlanEntry, RetireResult, ServerMessage } from '../../protocol.js'
import { SCOPE_REQUIRED } from '../../agents/isolation/retire-finished.js'
import { defineVerb, Report, type VerbContext } from '../command.js'

const RetireArgs = z
  .object({
    name: requiredString('name').optional(),
    force: z.boolean().optional(),
    finished: z.boolean().optional(),
    spawner: z.string().optional(),
    prefix: z.string().optional(),
    dryRun: z.boolean().optional(),
  })
  .superRefine((args, ctx) => {
    const problem = argsProblem(args)
    if (problem) ctx.addIssue({ code: 'custom', path: [problem.path], message: problem.message })
  })

type RetireArgs = z.infer<typeof RetireArgs>

/** CC-323: the bulk form is scoped, never forced, and never mixed with a name. */
function argsProblem(args: RetireArgs): { path: string; message: string } | undefined {
  const scoped = Boolean(args.spawner?.trim() || args.prefix?.trim())
  if (args.finished !== true) {
    if (scoped || args.dryRun === true)
      return { path: 'finished', message: '--spawner, --prefix and --dry-run need --finished' }
    if (args.name === undefined)
      return { path: 'name', message: 'name is required and must be a non-empty string' }
    return undefined
  }
  if (args.name !== undefined) return { path: 'name', message: '--finished retires by scope; drop the name' }
  if (args.force === true)
    return { path: 'force', message: '--force is refused with --finished; force one agent by name' }
  return scoped ? undefined : { path: 'finished', message: SCOPE_REQUIRED }
}

/**
 * `--force` is the flag the isolation's own refusal has always told people to
 * use, and until CC-79 it did not exist anywhere: no option here, no field on
 * the wire, and `socket.ts` calling `retire(name)` with the parameter left at
 * its default. Someone whose worktree held uncommitted work was told to pass a
 * flag that was silently ignored, and had to remove the worktree by hand.
 */
export const agentRetire = defineVerb({
  name: 'agent.retire',
  description: 'release isolation, end the process, and free the name',
  args: RetireArgs,
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      force: {
        long: '--force',
        description: 'discard uncommitted or unmerged work the isolation is holding',
      },
      finished: {
        long: '--finished',
        description: 'retire every finished agent in scope that holds no uncommitted or unpushed work',
      },
      spawner: {
        long: '--spawner',
        description: 'with --finished: only agents spawned by this session name',
      },
      prefix: { long: '--prefix', description: 'with --finished: only agents whose name starts with this' },
      dryRun: { long: '--dry-run', description: 'with --finished: print the plan and retire nothing' },
    },
  },
  async run(args, ctx) {
    if (args.finished === true) return retireFinished(args, ctx)
    return retireOne(args.name ?? '', args.force === true, ctx)
  },
})

async function retireOne(name: string, force: boolean, ctx: VerbContext): Promise<Report> {
  const res = (await ctx.withBroker(b =>
    b.request({ t: 'retire', name, ...(force ? { force: true } : {}) }, 'spawn_result'),
  )) as Extract<ServerMessage, { t: 'spawn_result' }>
  if (!res.ok) return { ok: false, lines: [`Not retired: ${res.reason}`] }
  // `reason` on a successful retire is a caveat, not a failure: what the broker
  // could not do (CC-77). Dropping it is what let a live process go unnoticed.
  const caveat = res.reason === undefined ? [] : [res.reason]
  return { ok: true, lines: [`Retired ${name}.`, ...caveat] }
}

/** A broker started before CC-323 drops the frame unanswered, so the timeout is the only sign. */
function tooOld(err: unknown): never {
  if (!/did not answer/.test((err as Error).message)) throw err
  throw new Error('the broker did not answer retire --finished; it may predate CC-323, so restart the broker')
}

async function retireFinished(args: RetireArgs, ctx: VerbContext): Promise<Report> {
  const frame = {
    t: 'retire_finished' as const,
    ...(args.spawner?.trim() ? { spawner: args.spawner } : {}),
    ...(args.prefix?.trim() ? { prefix: args.prefix } : {}),
    ...(args.dryRun === true ? { dryRun: true } : {}),
  }
  const res = (await ctx
    .withBroker(b => b.request(frame, 'retire_finished_result'))
    .catch(tooOld)) as Extract<ServerMessage, { t: 'retire_finished_result' }>
  if (res.reason !== undefined) return { ok: false, lines: [`Not retired: ${res.reason}`] }
  if (res.plan.length === 0) return { ok: true, lines: ['No agents match that scope.'] }
  const lines = ['Plan:', ...res.plan.map(planLine)]
  if (args.dryRun === true) return { ok: true, lines: [...lines, summary(res.plan, undefined)] }
  return {
    ok: res.ok,
    lines: [...lines, 'Results:', ...res.results.map(resultLine), summary(res.plan, res.results)],
  }
}

const planLine = (entry: RetirePlanEntry): string => {
  const who =
    entry.duplicate === true ? `${entry.name} [${entry.agentId ?? '?'}, DUPLICATE NAME]` : entry.name
  return entry.action === 'retire'
    ? `  retire ${who}`
    : `  skip   ${who}: ${entry.reason ?? 'no reason given'}`
}

const resultLine = (result: RetireResult): string => {
  const outcome = result.ok ? `  retired ${result.name}` : `  FAILED  ${result.name}`
  return result.reason === undefined ? outcome : `${outcome}: ${result.reason}`
}

function summary(plan: RetirePlanEntry[], results: RetireResult[] | undefined): string {
  const skipped = plan.filter(e => e.action === 'skip').length
  if (results === undefined) return `Dry run: ${plan.length - skipped} would be retired, ${skipped} skipped.`
  const retired = results.filter(r => r.ok).length
  return `${retired} retired, ${results.length - retired} failed, ${skipped} skipped.`
}
