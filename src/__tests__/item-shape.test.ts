import { describe, expect, it } from 'vitest'
import { readShape, shapeMeta } from '../inbox/item-shape.js'
import type { ItemShape } from '../protocol.js'

/** TP-695 slice a: the v2 ask meta keys, the contract the factory needs and the digest read. */

const FULL: ItemShape = {
  kind: 'decision',
  task: 'TP-695',
  header: 'Pick the store',
  options: ['sqlite', 'postgres'],
  optionDescriptions: ['local file, no server', ''],
  recommended: 'sqlite',
  onNoAnswer: 'parked',
  door: 'two-way',
  default: 'sqlite',
  category: 'tech_design',
  initiative: 'titan-platform',
  blocking: 'parked',
  reversible: 'swap the adapter back',
}

describe('ask meta v2', () => {
  it('round-trips every field through the stored meta', () => {
    const meta = shapeMeta(FULL)

    expect(readShape(meta)).toEqual(FULL)
    expect(meta).toMatchObject({
      header: 'Pick the store',
      option_descriptions: '["local file, no server",""]',
      door: 'two-way',
      default: 'sqlite',
      category: 'tech_design',
      initiative: 'titan-platform',
      blocking: 'parked',
      reversible: 'swap the adapter back',
    })
  })

  it('drops a door or blocking value outside its enum', () => {
    const frame = { ...FULL, door: 'sideways', blocking: 'maybe' } as unknown as ItemShape

    const meta = shapeMeta(frame)

    expect(meta).not.toHaveProperty('door')
    expect(meta).not.toHaveProperty('blocking')
  })

  // Mutation caught: dropping the label check on `default`.
  it('drops a default that is not one of the option labels', () => {
    expect(shapeMeta({ ...FULL, default: 'mysql' })).not.toHaveProperty('default')
    expect(shapeMeta({ default: 'sqlite' })).not.toHaveProperty('default')
  })

  it('caps nine options at eight and cuts their descriptions to match', () => {
    const options = Array.from({ length: 9 }, (_, i) => `o${i}`)
    const optionDescriptions = options.map(o => `about ${o}`)

    const shape = readShape(shapeMeta({ options, optionDescriptions }))

    expect(shape.options).toEqual(options.slice(0, 8))
    expect(shape.optionDescriptions).toEqual(optionDescriptions.slice(0, 8))
  })

  // Mutation caught: zipping descriptions after blank labels are filtered, shifting them one place.
  it('keeps each description on its own option when a blank option is dropped', () => {
    const meta = shapeMeta({
      options: ['a', ' ', 'c'],
      optionDescriptions: ['about a', 'about blank', 'about c'],
    })

    expect(JSON.parse(meta.options!)).toEqual(['a', 'c'])
    expect(JSON.parse(meta.option_descriptions!)).toEqual(['about a', 'about c'])
  })

  it('pads missing descriptions with empty strings and omits the key when none is given', () => {
    expect(
      JSON.parse(shapeMeta({ options: ['a', 'b'], optionDescriptions: ['about a'] }).option_descriptions!),
    ).toEqual(['about a', ''])
    expect(shapeMeta({ options: ['a', 'b'], optionDescriptions: ['', ' '] })).not.toHaveProperty(
      'option_descriptions',
    )
  })

  it('caps the header at 80 characters and the category at 40', () => {
    const meta = shapeMeta({ header: 'h'.repeat(200), category: 'c'.repeat(100) })

    expect(meta.header).toHaveLength(80)
    expect(meta.category).toHaveLength(40)
  })

  it('writes byte-identical meta for an ask with only the v1 fields', () => {
    const v1: ItemShape = {
      kind: 'decision',
      task: 't',
      options: ['a', 'b'],
      recommended: 'a',
      onNoAnswer: 'parked',
    }

    expect(JSON.stringify(shapeMeta(v1))).toBe(
      '{"kind":"decision","task":"t","recommended":"a","on_no_answer":"parked","options":"[\\"a\\",\\"b\\"]"}',
    )
  })

  it('reads a row whose descriptions do not line up with its options as having none', () => {
    const shape = readShape({ options: '["a","b"]', option_descriptions: '["only one"]' })

    expect(shape).toEqual({ options: ['a', 'b'] })
  })
})
