import { describe, expect, it } from 'vitest'
import { NODE_OPTIONS_INERT, nodeOptionsLoadsCode } from '../leak-guard/node-options.js'

describe('NODE_OPTIONS value matcher (TP-2856)', () => {
  it.each([
    '',
    '   ',
    '--max-old-space-size=8192',
    '--max_old_space_size=8192',
    '--max-old-space-size=4096 --enable-source-maps --no-warnings',
    '--unhandled-rejections=strict',
    '--disable-warning=ExperimentalWarning',
  ])('an inert value %j loads no code', value => {
    expect(nodeOptionsLoadsCode(value)).toBe(false)
  })

  it.each([
    '-r ./x',
    '-r./x',
    '--require=./x',
    '--require ./x',
    '--import=data:text/javascript,1',
    '--loader=./x',
    '--experimental-loader=./x',
    '--experimental_loader=./x',
    '--re_quire=./x',
    '--inspect',
    '--openssl-config=/x',
    '--snapshot-blob=/x',
    '--title=x',
    '--max-old-space-size=1 -r ./x',
    '--max-old-space-size=1\t-r',
    '--max-old-space-size 100',
    '--require "a b"',
    "--require='./x'",
    '--max-old-space-size=1\\ -r',
    '--max-old-space-size=$N',
    '--max-old-space-size=`n`',
  ])('a value %j may load code', value => {
    expect(nodeOptionsLoadsCode(value)).toBe(true)
  })

  it('lists only options node accepts in NODE_OPTIONS', () => {
    const unknown = [...NODE_OPTIONS_INERT].filter(name => !process.allowedNodeEnvironmentFlags.has(name))

    expect(unknown).toEqual([])
  })

  it.each(['--require', '-r', '--import', '--loader', '--experimental-loader', '--openssl-config'])(
    'leaves the code-loading option %s off the inert list',
    name => {
      expect(NODE_OPTIONS_INERT.has(name)).toBe(false)
    },
  )
})
