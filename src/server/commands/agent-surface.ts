import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const agentSurface = defineTool({
  name: 'agent_surface',
  description:
    'Pull a HEADLESS agent into a terminal window where your human can see it and answer it. Use ' +
    'this when a headless agent has gone quiet or looks stuck: a headless session is never shown a ' +
    'permission prompt, so anything it needed approval for was silently denied and it has no way to ' +
    'tell you that is what happened. Surfacing is the fix — the agent comes back with its name, its ' +
    'identity and its whole conversation intact, in a window. If you are in a terminal yourself it ' +
    'opens beside you in the same window; if you are headless it opens its own. COST, and say so if ' +
    'you report this: the agent is stopped and resumed, so whatever turn it was part way through is ' +
    'lost. Refused for an agent already in a terminal — agent_list shows where each one is.',
  args: z.object({
    name: requiredString('name').describe('The headless agent to bring up, as shown by agent_list.'),
  }),
  result: z.string(),
  async run({ name }, ctx) {
    const res = (await ctx.broker.request({ t: 'surface', name }, 'switch_result')) as Extract<
      ServerMessage,
      { t: 'switch_result' }
    >
    if (!res.ok) return `Not surfacing ${name}: ${res.reason}`
    // Where it LANDED, not where it was asked to go: the iTerm ladder downgrades
    // to a new window when an anchor is gone, and telling the human to look in
    // the wrong place is the failure this whole feature exists to prevent.
    const where =
      res.surface === 'iterm-window'
        ? 'a new iTerm window'
        : res.surface === 'iterm-tab'
          ? 'a new iTerm tab'
          : 'a pane in your window'
    return (
      `${res.name} is now in ${where}, resumed on its existing conversation and keeping its name. ` +
      'The turn it was part way through was interrupted by the switch. If it was stuck on a ' +
      'permission prompt, that prompt is answerable there now — tell your human to look.'
    )
  },
})
