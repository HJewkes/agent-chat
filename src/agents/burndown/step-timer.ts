/** CC-1192 (DISPATCH-WF S1): the tick's named stages, in run order. All but `config` run under the ledger lock. */
export type StepName =
  | 'config'
  | 'read-ledger'
  | 'brief-approve'
  | 'roster'
  | 'world'
  | 'seats'
  | 'observe'
  | 'decider'
  | 'plan'
  | 'collision'
  | 'scope-exhausted'
  | 'execute'
  | 'adopt'
  | 'decider-triage'
  | 'leak-check'
  | 'deliver'
  | 'write-ledger'

export interface TickStep {
  name: StepName
  ms: number
}

export interface StepTimer {
  time: <T>(name: StepName, fn: () => T | Promise<T>) => Promise<T>
  /** For a stage that is not one call; `stop` records it. */
  start: (name: StepName) => { stop: () => void }
  steps: () => TickStep[]
}

/**
 * Records each stage's duration when it settles, thrown or not, rounded to whole ms. A stage timed twice, as `plan`
 * is on either side of `collision`, is one entry, at its first place, holding both spans.
 */
export function stepTimer(clock: () => number = () => performance.now()): StepTimer {
  const recorded: TickStep[] = []
  const record = (name: StepName, ms: number): void => {
    const prior = recorded.find(s => s.name === name)
    if (prior === undefined) recorded.push({ name, ms })
    else prior.ms += ms
  }
  const start = (name: StepName): { stop: () => void } => {
    const startedAt = clock()
    return { stop: () => record(name, Math.round(clock() - startedAt)) }
  }
  return {
    time: async (name, fn) => {
      const span = start(name)
      try {
        return await fn()
      } finally {
        span.stop()
      }
    },
    start,
    steps: () => recorded.map(s => ({ ...s })),
  }
}
