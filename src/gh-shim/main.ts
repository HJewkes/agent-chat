import { runShim } from './shim.js'

/** Entry point of the `gh` on a spawned agent's PATH (CC-395); the shim itself is `shim.ts`. */
process.exitCode = await runShim(process.argv.slice(2))
