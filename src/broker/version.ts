/**
 * The one place the service version is stated.
 *
 * Not read from package.json at runtime: the built layout puts `dist/broker/` two
 * levels below the manifest, so the relative path differs between source and
 * build and would be a silent `undefined` in exactly one of them. A constant plus
 * the test in `lifecycle.test.ts` asserting it matches package.json is cheaper and
 * fails loudly at the moment they diverge.
 */
export const VERSION = '0.1.0'
