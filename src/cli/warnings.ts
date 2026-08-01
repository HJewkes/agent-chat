// node:sqlite is still flagged experimental and warns on first use. The warning
// would land in every CLI invocation and, worse, in the MCP server's stderr.
process.removeAllListeners('warning')
process.on('warning', warning => {
  if (warning.name !== 'ExperimentalWarning' || !warning.message.includes('SQLite')) console.warn(warning)
})
