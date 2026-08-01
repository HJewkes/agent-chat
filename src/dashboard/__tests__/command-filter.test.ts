import { describe, expect, it } from 'vitest'
import { filterCommands } from '../components/shared/command-filter.js'
import type { PaletteCommand } from '../components/shared/command-filter.js'

const noop = () => {}

const COMMANDS: PaletteCommand[] = [
  { id: 'nav:overview', label: 'Go to Overview', hint: '#overview', run: noop },
  { id: 'nav:queue', label: 'Go to Queue', hint: '#queue', run: noop },
  { id: 'nav:log', label: 'Go to Log', hint: '#log', keywords: 'history events', run: noop },
]

const labels = (query: string) => filterCommands(COMMANDS, query).map(c => c.label)

describe('command palette filtering', () => {
  it('returns everything for an empty query', () => {
    expect(filterCommands(COMMANDS, '   ')).toHaveLength(3)
  })

  it('matches case-insensitively on the label', () => {
    expect(labels('QUEUE')).toEqual(['Go to Queue'])
  })

  it('matches terms in any order', () => {
    expect(labels('queue go')).toEqual(['Go to Queue'])
  })

  it('matches the hint and undisplayed keywords', () => {
    expect(labels('#overview')).toEqual(['Go to Overview'])
    expect(labels('history')).toEqual(['Go to Log'])
  })

  it('returns nothing when one term misses', () => {
    expect(labels('queue history')).toEqual([])
  })
})
