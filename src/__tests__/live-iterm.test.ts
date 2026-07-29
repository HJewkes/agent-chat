import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { surfaceFor } from '../agents/surfaces/index.js'
import type { LaunchPlan } from '../agents/types.js'

/**
 * Does a spawn actually land where the ANCHOR says, in a real iTerm2?
 *
 * WHY THIS CANNOT BE A UNIT TEST. surfaces.test.ts asserts the generated
 * AppleScript does not contain `current window`, which is a proxy: it says the
 * script does not name the thing that follows focus, not that iTerm resolves the
 * script to the tab the human was looking at. Every other way of getting focus
 * wrong — `current session`, `current tab`, a `create tab` that attaches to the
 * frontmost window — passes that grep. Only iTerm can say which tab the pane
 * came out in, and only geometry read back off real sessions can say whether
 * three agents stacked in a column or tiled into a row.
 *
 * AND WHY THE POSITIVE CONTROL IS NOT OPTIONAL. "A pane appeared in tab A" passes
 * for the wrong reason whenever tab A happens to be the focused one — which is
 * the normal case, and precisely the regression this exists to catch. So the two
 * arms swap the roles: each anchors on one tab while the OTHER holds focus. A
 * placement that followed focus fails both; a placement that always picked some
 * fixed window fails one. Passing both means the anchor, and only the anchor,
 * decided.
 *
 * Opt-in: this drives the real iTerm2 and will open and close real windows on
 * the desktop. It touches only windows it created itself.
 *   AGENT_CHAT_LIVE=1 npx vitest run live-iterm
 */

const LIVE = process.env.AGENT_CHAT_LIVE === '1'

const osa = (script: string): string => execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim()

const iterm = (body: string): string => osa(`tell application "iTerm2"\n${body}\nend tell`)

/**
 * Every session in the tab that holds `uuid`, as a list. Tabs carry no id of
 * their own, so a tab is identified by the sessions in it — which is also the
 * form the placement assertion wants: "did the new pane come out beside the
 * anchor, or beside something else".
 */
const tabMates = (uuid: string): string[] =>
  iterm(`  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is "${uuid}" then
          set ids to ""
          repeat with mate in sessions of t
            set ids to ids & (unique ID of mate) & " "
          end repeat
          return ids
        end if
      end repeat
    end repeat
  end repeat
  return ""`)
    .split(/\s+/)
    .filter(id => id !== '')

interface Size {
  columns: number
  rows: number
}

const sizeOf = (uuid: string): Size => {
  const raw = iterm(`  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is "${uuid}" then return ((columns of s) as text) & "|" & ((rows of s) as text)
      end repeat
    end repeat
  end repeat
  return ""`)
  const [columns, rows] = raw.split('|').map(Number)
  expect(raw, `no live session with uuid ${uuid}`).not.toBe('')
  return { columns: columns as number, rows: rows as number }
}

/** Windows this file opened, and the only ones it will ever close. */
const opened: string[] = []

const openWindow = (): string => {
  const [id, uuid] = iterm(
    `  set w to (create window with default profile)
  return ((id of w) as text) & "|" & (unique ID of current session of current tab of w)`,
  ).split('|')
  opened.push(id as string)
  return uuid as string
}

const focusWindowOf = (uuid: string): void => {
  iterm(`  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (unique ID of s) is "${uuid}" then
          select w
          select t
          select s
        end if
      end repeat
    end repeat
  end repeat`)
}

const focused = (): string => iterm('  return unique ID of current session of current tab of current window')

let counter = 0

/**
 * Only `agentId` and `surface` reach an iTerm surface; the rest of the plan is
 * read by `run-agent` off disk. There is no agent behind this id, so the pane
 * shows an error and keeps its shell — which is all the test needs it to do,
 * and avoids starting real models to measure a pane.
 */
const plan = (): LaunchPlan => ({
  agentId: `aglive${String(++counter).padStart(2, '0')}`,
  bin: 'claude',
  args: [],
  cwd: process.cwd(),
  env: {},
  title: 'live placement probe',
  surface: 'iterm-pane',
})

const spawnPane = async (anchor: string, columnAfter?: string): Promise<string> => {
  const handle = await surfaceFor('iterm-pane', { anchor, ...(columnAfter ? { columnAfter } : {}) }).launch(
    plan(),
  )
  expect(handle.surface, 'fell back to a window, so nothing was placed against the anchor').toBe('iterm-pane')
  return handle.paneRef as string
}

/**
 * The scan is itself racing the teardown it is watching — a window that vanishes
 * between `windows` and `id of w` takes the whole script down. That failure means
 * "still closing", so it reads as a window list we have not settled on yet.
 */
const liveWindowIds = (): string[] | undefined => {
  try {
    return iterm(`  set ids to ""
  repeat with w in windows
    set ids to ids & ((id of w) as text) & " "
  end repeat
  return ids`)
      .split(/\s+/)
      .filter(id => id !== '')
  } catch {
    return undefined
  }
}

/**
 * Closes the window whole rather than session by session: `close` on a session
 * renumbers the ones after it, and an AppleScript `repeat` resolves each item by
 * index, so walking a shrinking list errors out partway and strands the rest.
 *
 * Then waits for them to be gone. iTerm acknowledges `close` well before the
 * window disappears, and a window still closing is a window whose sessions can
 * vanish mid-scan — which is a fine way to make the NEXT run of this file fail
 * for a reason that has nothing to do with placement.
 */
afterAll(async () => {
  const mine = opened.splice(0)
  for (const id of mine) {
    try {
      iterm(`  close (first window whose id is (${id} as integer))`)
    } catch {
      // Already closed, by an earlier failure or by hand. Nothing left to do.
    }
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = liveWindowIds()
    if (live !== undefined && !mine.some(id => live.includes(id))) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
})

describe.skipIf(!LIVE)('iTerm pane placement, against a real iTerm2', () => {
  it('places the pane in the anchored tab while another window holds focus', async () => {
    const anchor = openWindow()
    const distraction = openWindow()

    focusWindowOf(distraction)
    expect(focused(), 'could not move focus off the anchor, so this arm proves nothing').toBe(distraction)

    const pane = await spawnPane(anchor)

    expect(tabMates(pane)).toContain(anchor)
    expect(tabMates(pane)).not.toContain(distraction)
  }, 60_000)

  it('follows the anchor when the roles are swapped — the control that proves focus is not deciding', async () => {
    const anchor = openWindow()
    const distraction = openWindow()

    focusWindowOf(anchor)
    expect(focused(), 'could not move focus onto the anchor, so this arm proves nothing').toBe(anchor)

    const pane = await spawnPane(distraction)

    expect(tabMates(pane)).toContain(distraction)
    expect(tabMates(pane)).not.toContain(anchor)
  }, 60_000)

  /**
   * The layout measured by hand: the anchor gave up width exactly once (cols
   * 190 -> 94) and three agents stacked at full width of that column, rows=23
   * each. Restated as properties, since a window here is not 190 columns wide:
   * the anchor narrows on the first spawn and never again, and the agents share
   * one width while dividing the height between them.
   */
  it('stacks three agents in one column instead of re-splitting the anchor', async () => {
    const anchor = openWindow()
    const full = sizeOf(anchor)

    const first = await spawnPane(anchor)
    const afterFirst = sizeOf(anchor)
    const second = await spawnPane(anchor, first)
    const third = await spawnPane(anchor, second)

    const agents = [first, second, third]
    for (const pane of agents) expect(tabMates(pane)).toContain(anchor)

    const sizes = agents.map(sizeOf)
    const settled = sizeOf(anchor)

    expect(afterFirst.columns).toBeLessThan(full.columns)
    // The regression this replaced: every spawn split the ANCHOR, so its width
    // halved per agent (80 -> 39 -> 19 -> 9 at this window size) and the agents
    // came out as a row of columns, each still full height.
    expect(settled.columns).toBe(afterFirst.columns)
    expect(settled.rows).toBe(afterFirst.rows)

    // One column: same width as each other, and as the strip the anchor gave up.
    expect(new Set(sizes.map(size => size.columns)).size).toBe(1)
    for (const size of sizes) expect(Math.abs(size.columns - settled.columns)).toBeLessThanOrEqual(1)

    // Stacked, not stacked-on-top-of-each-other: each agent gets about a third of
    // the height, and between them they use up the column. The slack absorbs the
    // per-pane title bars iTerm adds once a tab holds more than one session.
    const stacked = sizes.reduce((total, size) => total + size.rows, 0)
    expect(stacked).toBeLessThan(settled.rows)
    expect(stacked).toBeGreaterThan(settled.rows / 2)
    const rows = sizes.map(size => size.rows)
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1)
    for (const size of sizes) expect(size.rows).toBeLessThan(settled.rows / 2)
  }, 90_000)
})
