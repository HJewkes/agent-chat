import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCodeAncestor, defaultSs, linuxPeerPortsWith } from '../broker/peer-locality.js'

/** CC-896 on a real unix socket; CC-1164 makes an empty read say whether ss timed out or lost the row. */

interface SsRead {
  elapsedMs: number
  error?: string
  output?: string
}

const recordingSs = (reads: SsRead[]) => (): string => {
  const started = performance.now()
  const read: SsRead = { elapsedMs: 0 }
  reads.push(read)
  try {
    read.output = defaultSs()
    return read.output
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { signal?: string }
    read.error = `${e.code ?? ''} ${e.signal ?? ''} ${e.message}`.trim()
    throw err
  } finally {
    read.elapsedMs = Math.round(performance.now() - started)
    if (read.elapsedMs > 500) console.info(`ss -xnpH took ${read.elapsedMs} ms`)
  }
}

const inodeOf = (conn: net.Socket): string | undefined => {
  const fd = (conn as unknown as { _handle?: { fd?: number } })._handle?.fd
  return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${fd}`))?.[1]
}

/** The ss rows for the server end and its peer, so a missing or shared row shows in the failure. */
const rowsFor = (output: string | undefined, inode: string | undefined): string[] => {
  const rows = (output ?? '').split('\n').map(line => line.trim().split(/\s+/))
  const mine = rows.find(cols => cols[5] === inode)
  const theirs = rows.find(cols => mine?.[7] !== undefined && cols[5] === mine[7])
  return [mine?.join(' ') ?? `no row for inode ${inode}`, theirs?.join(' ') ?? `no row for peer ${mine?.[7]}`]
}

const opened: Array<() => void> = []

/** The client end is held by a child process, so the peer's pid differs from the server end's. */
const connectedPair = async (): Promise<{ serverSide: net.Socket; peer: number }> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-peer-'))
  const sock = path.join(dir, 's.sock')
  const server = net.createServer().listen(sock)
  await new Promise(resolve => server.once('listening', resolve))
  const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve))
  const holdClientEnd = `require('net').connect(${JSON.stringify(sock)}); setTimeout(() => {}, 30000)`
  const client = spawn(process.execPath, ['-e', holdClientEnd], { stdio: 'ignore' })
  const serverSide = await accepted
  opened.push(() => {
    client.kill()
    serverSide.destroy()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { serverSide, peer: client.pid ?? -1 }
}

afterEach(() => {
  opened.splice(0).forEach(close => close())
})

describe.skipIf(process.platform !== 'linux')('linuxPeerPorts on a real socket', () => {
  it('names the process holding the client end as the peer', async () => {
    const { serverSide, peer } = await connectedPair()
    const reads: SsRead[] = []
    const ports = linuxPeerPortsWith(recordingSs(reads))

    const pid = ports.peerPid(serverSide)

    const read = reads[0]
    const detail = JSON.stringify({
      elapsedMs: read?.elapsedMs,
      error: read?.error,
      rows: rowsFor(read?.output, inodeOf(serverSide)),
    })
    expect(pid, `ss read: ${detail}`).toBe(peer)
    expect(claudeCodeAncestor(serverSide, ports)).toBe(claudeCodeAncestor(serverSide, ports))
  })

  it('reads no peer when ss throws, as it does on a timeout', async () => {
    const { serverSide } = await connectedPair()
    let calls = 0
    const ports = linuxPeerPortsWith(() => {
      calls++
      throw Object.assign(new Error('spawnSync ss ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })

    expect(ports.peerPid(serverSide)).toBeUndefined()
    expect(calls).toBe(1)
  })
})
