/** Compatibility imports only; setup parsing, guards, environment, execution and reports live in the shared package. */
export {
  DEFAULT_SETUP_TIMEOUT_MS,
  NPMRC_FILE,
  PNPM_WORKSPACE_FILE,
  SETUP_FILE,
  SETUP_LOG,
  parseSetupStep,
  runSetupCommand,
  runWorktreeSetup,
  setupEnv,
  setupWorktree,
  type SetupOutcome,
  type SetupReport,
  type SetupResult,
  type SetupRunner,
  type SetupStep,
  type SetupTarget,
} from '@titan-design/worktree'
