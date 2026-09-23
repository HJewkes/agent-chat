import { z } from 'zod'
import { present, requiredString } from '../../args.js'
import { DECLARED_MAX_KEYS, DECLARED_MAX_VALUE_CHARS, type ServerMessage } from '../../protocol.js'
import { observedRegistration } from '../../git.js'
import { cliEntry } from '../../paths.js'
import { terminalAnchor } from '../anchor.js'
import { hostIdentity } from '../host.js'
import { declaredField, declaredLabels, defineTool } from '../command.js'

export const chatRegister = defineTool({
  name: 'chat_register',
  description:
    'Call this FIRST, before your first substantive tool call — before editing files, before spawning ' +
    'anything, before starting independent work. It costs one line and is the only way peers can address ' +
    "you or see you in chat_list; skipping it makes you invisible to anyone checking who's already " +
    "working in this checkout. The name is held until this session exits. If you're unsure whether to " +
    "register, register — it's free, reversible, and the default should be yes.",
  args: z.object({
    name: requiredString('name').describe('Short handle for this session, e.g. "voltras-ui"'),
    working_on: z.string().describe('One line on what this session is doing').optional(),
    declared: declaredField(
      'Optional short labels other sessions can filter and read you by, e.g. ' +
        '{"role": "implementer", "initiative": "claude-channels", "task": "CC-11"}. Keys are ' +
        'yours to choose. Peers see these marked as self-reported, so declare what is true. ' +
        `At most ${DECLARED_MAX_KEYS} keys, ${DECLARED_MAX_VALUE_CHARS} characters each. Your ` +
        'branch and checkout are NOT declared here — the server reads those from this process.',
    ),
  }),
  result: z.string(),
  async run(input, { broker, session }) {
    const { name } = input
    const declared = declaredLabels(input.declared)
    // A spawned agent was named by whoever spawned it, and peers have already
    // been told that name. Letting the model rename itself mid-session would
    // strand every one of them, so the call is a no-op rather than a rename.
    if (session.fixed) {
      if (name === session.name()) return `Already registered as "${name}" by the agent that spawned you.`
      return `You are already registered as "${session.name()}" (spawned agent); that name is fixed for this session.`
    }

    const res = (await broker.request(
      {
        t: 'register',
        name,
        workingOn: present(input.working_on) ?? '',
        cwd: process.cwd(),
        pid: process.pid,
        // The half of this registration the model did not choose. `name` and
        // `workingOn` above came from the model; these came from the process,
        // which is what lets the broker mint an identity for an ordinary session
        // without that identity being self-asserted.
        ...hostIdentity(),
        ...terminalAnchor(),
        // CC-11. Derived from this process's directory, never asked of the model:
        // "which checkout am I in" is knowable, and a self-reported answer to a
        // knowable question is a downgrade dressed as a feature.
        ...(await observedRegistration()),
        ...(declared === undefined ? {} : { declared }),
        // CC-36: lets the broker say so when this session's tools come from a
        // different build than the one it is talking to.
        build: cliEntry(),
      },
      'register_result',
    )) as Extract<ServerMessage, { t: 'register_result' }>
    if (!res.ok) return `Registration failed: ${res.reason}`
    // CC-82: the session may already have been registered provisionally by its
    // own MCP server, under a name derived from its directory. Saying so matters
    // — peers may have addressed the old name, and it is about to stop working.
    const previous = session.name()
    session.adopt(name)
    if (previous !== null && previous !== name)
      return (
        `Registered as "${name}", replacing the provisional name "${previous}" your MCP server ` +
        'assigned from this directory. Peers addressing the old name will need the new one.'
      )
    return `Registered as "${name}". Other sessions can reach you by that name until this session exits.`
  },
})
