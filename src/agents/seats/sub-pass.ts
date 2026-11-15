/** A pass the seat watchdog runs after its seats pass on a full run; its failure costs only its own lines. */
export interface SubPass {
  label: string
  run: () => Promise<string[]>
}

async function isolated(pass: SubPass): Promise<string[]> {
  try {
    return await pass.run()
  } catch (err) {
    return [`${pass.label}: failed: ${err instanceof Error ? err.message : String(err)}`]
  }
}

/** The seats pass, then each sub-pass in order unless the run names its seats (`--seat`). */
export async function watchdogLines(
  seatsPass: () => Promise<string[]>,
  subPasses: readonly SubPass[],
  partial: boolean,
): Promise<string[]> {
  const lines = [...(await seatsPass())]
  if (partial) return lines
  for (const pass of subPasses) lines.push(...(await isolated(pass)))
  return lines
}
