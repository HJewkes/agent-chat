export const parsePort = (value: string): number => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) throw new Error(`bad port: ${value}`)
  return parsed
}
