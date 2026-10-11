import fs from 'node:fs'

/**
 * Body text as gh-write scans it (CC-726). Bytes that are UTF-16 (a BOM, or the NUL every ASCII
 * character carries in UTF-16 and UTF-32) are refused rather than decoded: read as UTF-8 a term
 * would hide between NULs, and gh posts the raw bytes regardless of what the scan saw.
 */

/** A body or stdin that is not UTF-8 text, so it cannot be scanned as gh would post it. */
export const NOT_UTF8 = Symbol('not-utf8')

const startsUtf16Bom = (bytes: Buffer): boolean =>
  bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))

export function utf8Body(bytes: Buffer): string | typeof NOT_UTF8 {
  return startsUtf16Bom(bytes) || bytes.includes(0) ? NOT_UTF8 : bytes.toString('utf8')
}

/** Opened without blocking and read only when regular, so a FIFO or a device cannot hang the scan. */
export function readBodyFile(file: string): string | undefined | typeof NOT_UTF8 {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    return fs.fstatSync(fd).isFile() ? utf8Body(fs.readFileSync(fd)) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
