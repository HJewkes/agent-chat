import type { Command as Commander } from 'commander'
import { z } from 'zod'
import {
  EXIT,
  collectCliArgs,
  collectOptionParser,
  commandPath,
  defineCommand,
  invokeCommand,
  optionFlagSpec,
  positionalSpec,
  type BaseContext,
  type Command,
} from '@titan-design/registry'
import { withBroker } from './client.js'

/** What a verb's `run` is handed: a broker connection scoped to the one call. */
export interface VerbContext extends BaseContext {
  withBroker: typeof withBroker
}

/** Lines for stdout, and whether the broker did what was asked, which decides the exit status. */
export const Report = z.object({
  ok: z.boolean(),
  lines: z.array(z.string()),
  /** A run-level refusal (legacy `fail()`'s stderr line), printed before the exit it causes. */
  errors: z.array(z.string()).optional(),
})
export type Report = z.infer<typeof Report>

export type Verb<Args> = Command<Args, Report, VerbContext>

export const defineVerb = <Args>(verb: Verb<Args>): Verb<Args> => defineCommand(verb)

/**
 * Adds a registry verb under `parent`, spelled and described exactly as its
 * definition says. A hidden mount skips the description too, matching every
 * other hidden alias in this file (`broker`, `mcp`, `run-agent`): nothing
 * reachable only by knowing its name in advance needs to advertise itself.
 */
export function addVerb<Args>(
  parent: Commander,
  verb: Verb<Args>,
  options: { helpGroup?: string; hidden?: boolean } = {},
): void {
  const sub = parent.command(
    commandPath(verb.name).at(-1) ?? verb.name,
    options.hidden ? { hidden: true } : undefined,
  )
  if (!options.hidden) sub.description(verb.description)
  if (options.helpGroup !== undefined) sub.helpGroup(options.helpGroup)
  for (const name of verb.cli?.positional ?? []) sub.argument(positionalSpec(verb, name))
  for (const [key, option] of Object.entries(verb.cli?.options ?? {})) {
    const parser = collectOptionParser(verb, key)
    const spec = optionFlagSpec(verb, key, option)
    if (parser) sub.option(spec, option.description, parser)
    else sub.option(spec, option.description)
  }
  sub.action(() => runVerb(verb, sub.processedArgs, sub.opts()))
}

async function runVerb<Args>(verb: Verb<Args>, positionals: unknown[], opts: Record<string, unknown>) {
  const ctx: VerbContext = { warnings: [], format: 'human', withBroker }
  const args = collectCliArgs(verb, positionals, opts)
  const { envelope, exitCode } = await invokeCommand(verb, args, ctx, { invalidArgsCode: EXIT.USAGE })
  if (!envelope.ok) {
    console.error(envelope.error)
    process.exit(exitCode)
  }
  const report = verb.result.parse(envelope.data)
  for (const line of report.lines) console.log(line)
  for (const error of report.errors ?? []) console.error(error)
  process.exit(report.ok ? 0 : 1)
}
