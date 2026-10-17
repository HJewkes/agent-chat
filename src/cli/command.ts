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
  optionDefault,
  positionalSpec,
  type BaseContext,
  type Command,
} from '@titan-design/registry'
import { createInterface } from 'node:readline/promises'
import { withBroker } from './client.js'

/** The person at the keyboard, if there is one: stdin a TTY, and a way to ask them a line. */
export interface Terminal {
  isTTY: boolean
  ask(prompt: string): Promise<string>
}

/** What a verb's `run` is handed: a broker connection scoped to the one call. */
export interface VerbContext extends BaseContext {
  withBroker: typeof withBroker
  /** Absent means no terminal, so a verb that needs a typed confirm refuses. */
  terminal?: Terminal
}

export const stdinTerminal = (): Terminal => ({
  isTTY: process.stdin.isTTY === true,
  async ask(prompt) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(prompt)
    } finally {
      rl.close()
    }
  },
})

/** Lines for stdout, and whether the broker did what was asked, which decides the exit status. */
export const Report = z.object({
  ok: z.boolean(),
  lines: z.array(z.string()),
  /** A run-level refusal (legacy `fail()`'s stderr line), printed before the exit it causes. */
  errors: z.array(z.string()).optional(),
  /** The exit status when `ok` is false, for a verb whose caller keys on more than 1 (the port verbs' 69). */
  exit: z.number().int().optional(),
})
export type Report = z.infer<typeof Report>

export type Verb<Args> = Command<Args, Report, VerbContext>

export const defineVerb = <Args>(verb: Verb<Args>): Verb<Args> => defineCommand(verb)

export function cliArgs<Args>(verb: Verb<Args>, positionals: unknown[], opts: Record<string, unknown>) {
  return collectCliArgs(verb, positionals, opts)
}

/**
 * Adds a registry verb under `parent`, spelled and described exactly as its
 * definition says. A hidden mount skips the description too, matching every
 * other hidden alias in this file (`broker`, `mcp`, `run-agent`): nothing
 * reachable only by knowing its name in advance needs to advertise itself.
 */
export function addVerb<Args>(
  parent: Commander,
  verb: Verb<Args>,
  options: {
    helpGroup?: string
    hidden?: boolean
    /** Mount the same definition as Commander's default child. */
    isDefault?: boolean
    usageExit?: number
    schemaDefaults?: boolean
    /** Preserve a migrated command's natural success return and pending output. */
    exitOnSuccess?: boolean
    /** Assign the completed report code and return naturally; takes precedence over exitOnSuccess. */
    reportExit?: 'set-code'
  } = {},
): Commander {
  const sub = parent.command(
    commandPath(verb.name).at(-1) ?? verb.name,
    options.hidden || options.isDefault === true
      ? {
          ...(options.hidden ? { hidden: true } : {}),
          ...(options.isDefault === true ? { isDefault: true } : {}),
        }
      : undefined,
  )
  if (!options.hidden) sub.description(verb.description)
  if (options.helpGroup !== undefined) sub.helpGroup(options.helpGroup)
  for (const name of verb.cli?.positional ?? []) sub.argument(positionalSpec(verb, name))
  for (const [key, option] of Object.entries(verb.cli?.options ?? {})) {
    const parser = collectOptionParser(verb, key)
    const spec = optionFlagSpec(verb, key, option)
    if (options.schemaDefaults === true) {
      const mounted = sub.createOption(spec, option.description).default(optionDefault(verb, key))
      if (parser) mounted.argParser(parser)
      sub.addOption(mounted)
    } else if (parser) sub.option(spec, option.description, parser)
    else sub.option(spec, option.description)
  }
  const usageExit = options.usageExit ?? EXIT.USAGE
  if (options.usageExit !== undefined)
    sub.exitOverride(err => process.exit(err.exitCode === 0 ? 0 : usageExit))
  sub.action(() =>
    runVerb(
      verb,
      sub.processedArgs,
      sub.opts(),
      usageExit,
      options.exitOnSuccess ?? true,
      options.reportExit,
    ),
  )
  return sub
}

async function runVerb<Args>(
  verb: Verb<Args>,
  positionals: unknown[],
  opts: Record<string, unknown>,
  usageExit: number,
  exitOnSuccess: boolean,
  reportExit?: 'set-code',
) {
  const ctx: VerbContext = { warnings: [], format: 'human', withBroker, terminal: stdinTerminal() }
  const args = cliArgs(verb, positionals, opts)
  const { envelope, exitCode } = await invokeCommand(verb, args, ctx, { invalidArgsCode: usageExit })
  if (!envelope.ok) {
    console.error(envelope.error)
    process.exit(exitCode)
  }
  const report = verb.result.parse(envelope.data)
  for (const line of report.lines) console.log(line)
  for (const error of report.errors ?? []) console.error(error)
  const code = report.ok ? 0 : (report.exit ?? 1)
  if (reportExit === 'set-code') {
    process.exitCode = code
    return
  }
  if (report.ok && !exitOnSuccess) return
  process.exit(code)
}
