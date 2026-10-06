import fs from 'node:fs'
import type { MemoryReading, SwapReading } from './machine-guard.js'

/**
 * CC-805: the machine guard's Linux readings, from /proc. Each parser returns the darwin
 * reading shape, so the spawn guard, seat status and seat stops need no Linux branch.
 */

export type ReadFile = (path: string) => string

export const readProcFile: ReadFile = path => fs.readFileSync(path, 'utf8')

export const PROC_MEMINFO = '/proc/meminfo'
export const PROC_PRESSURE_MEMORY = '/proc/pressure/memory'

/** The share of the last minute some task stalled on memory, from PSI "some avg60". */
export type PsiReading = { someAvg60: number } | { error: string }

// Spec health line for the concurrency ramp: PSI memory "some" avg60 under 10% is healthy.
export const PSI_WARN_AVG60 = 10
// A task stalled on memory for 40% of the last minute is thrashing, not just tight.
export const PSI_CRITICAL_AVG60 = 40

/** Darwin's kern.memorystatus_vm_pressure_level scale, so the CC-492 stop reads PSI unchanged. */
const PRESSURE_NORMAL = 1
const PRESSURE_WARN = 2
const PRESSURE_CRITICAL = 4

const KIB = 1024

function meminfoKib(text: string, field: string): number | undefined {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text)
  return match === null ? undefined : Number(match[1])
}

/** Free memory as MemAvailable over MemTotal, in whole percent rounded down. */
export function parseMeminfoFree(text: string): MemoryReading {
  const total = meminfoKib(text, 'MemTotal')
  const available = meminfoKib(text, 'MemAvailable')
  if (total === undefined || available === undefined || total <= 0 || available > total)
    return { error: `unparsed ${PROC_MEMINFO}: no MemTotal and MemAvailable` }
  return { freePercent: Math.floor((available / total) * 100) }
}

/** Swap used as SwapTotal less SwapFree; a box with no swap reads total 0. */
export function parseMeminfoSwap(text: string): SwapReading {
  const total = meminfoKib(text, 'SwapTotal')
  const free = meminfoKib(text, 'SwapFree')
  if (total === undefined || free === undefined || free > total)
    return { error: `unparsed ${PROC_MEMINFO}: no SwapTotal and SwapFree` }
  return { usedBytes: (total - free) * KIB, totalBytes: total * KIB }
}

/** Parses the "some" line of /proc/pressure/memory: `some avg10=0.00 avg60=1.25 avg300=0.40 total=123`. */
export function parsePsiMemory(text: string): PsiReading {
  const match = /^some avg10=[\d.]+ avg60=(\d+(?:\.\d+)?) /m.exec(text)
  const avg60 = match === null ? NaN : Number(match[1])
  if (!(avg60 >= 0 && avg60 <= 100)) return { error: `unparsed ${PROC_PRESSURE_MEMORY}: no some avg60` }
  return { someAvg60: avg60 }
}

/** Maps PSI some avg60 onto darwin's 1 normal, 2 warn, 4 critical pressure levels. */
export function psiPressureLevel(psi: { someAvg60: number }): number {
  if (psi.someAvg60 >= PSI_CRITICAL_AVG60) return PRESSURE_CRITICAL
  if (psi.someAvg60 >= PSI_WARN_AVG60) return PRESSURE_WARN
  return PRESSURE_NORMAL
}

/** Reads one /proc file and parses it; a missing or unreadable file is an error reading. */
export function readProc<T>(
  path: string,
  parse: (text: string) => T | { error: string },
  readFile: ReadFile,
): T | { error: string } {
  try {
    return parse(readFile(path))
  } catch (err) {
    return { error: `read ${path} failed: ${(err as Error).message}` }
  }
}
