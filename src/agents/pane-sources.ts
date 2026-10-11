import fs from 'node:fs'
import path from 'node:path'
import type { PaneSources, SeatPrefix } from '@titan-design/agent-surface'
import { resolvePaneColourConfig } from '../config.js'
import { frontmatterField } from './active-work.js'
import { currentAutonomyRoot } from './autonomy-root.js'
import { charterSeats } from './seats/charter.js'

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Every seat the autonomy charter lists that declares a prefix; none when the charter is absent. */
export function seatPrefixes(root = currentAutonomyRoot()): SeatPrefix[] {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) return []
  return charterSeats(charter).flatMap(name => {
    const prefix = frontmatterField(readText(path.join(root, 'seats', `${name}.md`)) ?? '', 'prefix')
    return prefix === undefined || prefix === '' ? [] : [{ name, prefix }]
  })
}

/** The package defaults to no seats and no colours, so a visible pane keeps its identity only through this. */
export const diskPaneSources: PaneSources = {
  seats: () => seatPrefixes(),
  colours: resolvePaneColourConfig,
  profile: plan => plan.env.AGENT_CHAT_PROFILE,
}
