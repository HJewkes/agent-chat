#!/usr/bin/env node
// The CLI itself lives in ./cli/, which also owns the node:sqlite warning
// suppression that has to run before anything else.
import { run } from './cli/index.js'

run().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
