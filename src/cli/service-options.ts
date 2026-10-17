import { MAX_HOLD_SECONDS } from '../broker/hold.js'

export const parsePort = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) throw new Error(`bad port: ${value}`)
  return parsed
}

export const holdSeconds = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_HOLD_SECONDS)
    throw new Error(`bad --hold: ${value} (whole seconds, 1 to ${MAX_HOLD_SECONDS})`)
  return parsed
}
