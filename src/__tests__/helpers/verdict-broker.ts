import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * TP-4256 A3: `run-agent` asks the broker's ledger before it launches, and refuses when no broker
 * answers. For suites about the launch itself, this stands in a broker under `home` that allows
 * every relaunch. It is its own process, so a `spawnSync` of the CLI cannot starve it.
 */
const ALLOW_EVERY_RELAUNCH = `
const net = require('node:net')
const server = net.createServer(socket => {
  let buffered = ''
  socket.on('error', () => undefined)
  socket.on('data', chunk => {
    buffered += chunk
    for (let end = buffered.indexOf('\\n'); end !== -1; end = buffered.indexOf('\\n')) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (line.includes('"integrity_relaunch"'))
        socket.write(JSON.stringify({ t: 'integrity_relaunch_result', ok: true }) + '\\n')
    }
  })
})
server.listen(process.argv[1], () => process.stdout.write('listening\\n'))
`

/** Resolves once the socket listens; the returned function stops the stub. */
export function startVerdictBroker(home: string): Promise<() => void> {
  const child = spawn(process.execPath, ['-e', ALLOW_EVERY_RELAUNCH, path.join(home, 'chat.sock')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const stop = () => void child.kill()
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(stop))
    child.once('exit', code => reject(new Error(`verdict broker exited ${code}`)))
  })
}
