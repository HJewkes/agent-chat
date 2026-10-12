import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCTOR_HEALTH_TIMEOUT_MS, describeHealth, probeHealthOutcome } from '../broker/doctor.js'

const servers: http.Server[] = []

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function closedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
})

describe('doctor /health probe', () => {
  it('reads a broker that answers /health after a second as healthy', async () => {
    const port = await listen((_req, res) => {
      setTimeout(() => res.end(JSON.stringify({ sessions: 3 })), 1_000)
    })

    const outcome = await probeHealthOutcome(port, DOCTOR_HEALTH_TIMEOUT_MS)

    expect(outcome).toEqual({ health: { sessions: 3 } })
    expect(describeHealth(port, outcome, DOCTOR_HEALTH_TIMEOUT_MS).status).toBe('ok')
  })

  it('reports a bound port that never answers as a busy broker, not an unbound one', async () => {
    const port = await listen(() => {})

    const outcome = await probeHealthOutcome(port, 200)
    const check = describeHealth(port, outcome, DOCTOR_HEALTH_TIMEOUT_MS)

    expect(outcome).toEqual({ failure: 'timeout' })
    expect(check.detail).toContain('did not answer within 3s')
    expect(check.detail).toContain('busy')
    expect(check.detail).not.toContain('not bound')
  })

  it('reports a closed port as not bound', async () => {
    const port = await closedPort()

    const outcome = await probeHealthOutcome(port, DOCTOR_HEALTH_TIMEOUT_MS)
    const check = describeHealth(port, outcome, DOCTOR_HEALTH_TIMEOUT_MS)

    expect(outcome).toEqual({ failure: 'refused' })
    expect(check.status).toBe('warn')
    expect(check.detail).toContain('not be bound')
  })

  it('reports an error status from /health as bound but unhealthy', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 500
      res.end()
    })

    const outcome = await probeHealthOutcome(port, DOCTOR_HEALTH_TIMEOUT_MS)

    expect(outcome).toEqual({ failure: 'http' })
    expect(describeHealth(port, outcome, DOCTOR_HEALTH_TIMEOUT_MS).detail).toContain('answered with an error')
  })
})
