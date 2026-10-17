import type { Verb } from '../cli/command.js'

/** Compile-only counterpart of the original report helper's inference boundary. */
function reportArgs<A>(verb: Verb<A>, args: NoInfer<A>) {
  return { verb, args }
}

export function literalArgumentContract(verb: Verb<{ frameStdin: true }>) {
  reportArgs(verb, { frameStdin: true })
  // @ts-expect-error false cannot satisfy a required true switch
  reportArgs(verb, { frameStdin: false })
  // @ts-expect-error the required switch cannot be omitted
  reportArgs(verb, {})
  // @ts-expect-error unrelated argument names do not satisfy this verb
  reportArgs(verb, { messageStdin: true })
}
