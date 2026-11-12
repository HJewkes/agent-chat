import { shortCommit } from '../build-commit.js'

/**
 * CC-1728: say so when a host launcher's agent-chat build differs from the broker's.
 *
 * A remote machine reaches the broker over a forward and runs its own checkout, which nothing
 * rebuilds when the broker is deployed. Its MCP servers then fail to register for reasons that
 * name some other cause. The launcher is the one long-lived process there that reconnects after
 * every deploy, so its hello is where the drift is caught.
 *
 * Once per host per broker commit: a launcher reconnects on every drop, and a notice per
 * reconnect would teach the reader to ignore it.
 */
export interface DriftSink {
  notify(body: string): void
  log(detail: Record<string, unknown>): void
}

export class LauncherDrift {
  private readonly noticed = new Set<string>()

  constructor(
    private readonly brokerCommit: string | undefined,
    private readonly sink: DriftSink,
  ) {}

  /** Checks one accepted hello; an unstamped broker has nothing to compare against and says nothing. */
  hello(host: string, launcherCommit: string | undefined): void {
    const broker = this.brokerCommit
    if (broker === undefined || launcherCommit === broker) return
    const key = `${host.toLowerCase()}@${broker}`
    if (this.noticed.has(key)) return
    this.noticed.add(key)
    this.sink.log({ host, launcher: launcherCommit ?? null, broker })
    this.sink.notify(
      `host ${host} runs agent-chat ${shortCommit(launcherCommit)}, broker ${shortCommit(broker)}; ` +
        `rebuild agent-chat there at ${shortCommit(broker)}, or its sessions may fail to register.`,
    )
  }
}
