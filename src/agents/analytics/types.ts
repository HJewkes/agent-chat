/**
 * Shapes for parsing Claude Code's own transcript JSONL (`agents/transcript.ts`
 * finds the file; this module turns it into structured analytics for a
 * dashboard). Ported from brain's `src/modules/sessions/types.ts` — only the
 * parser-facing subset, none of brain's PM/DB persistence shapes.
 */

export interface MessageContent {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | MessageContent[]
  is_error?: boolean
  text?: string
  thinking?: string
}

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface ToolCall {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  timestamp: string
  outcome: 'success' | 'error' | 'pending'
  errorMessage?: string | undefined
  durationMs?: number | undefined
  byteOffset?: number | undefined
  isSidechain: boolean
}

export interface ErrorEvent {
  timestamp: string
  toolName?: string | undefined
  toolUseId?: string
  message: string
  isSidechain: boolean
}

export type FrictionKind = 'consecutive_identical_tool' | 'error_loop' | 'user_correction' | 'hook_prevention'

export interface FrictionSignal {
  kind: FrictionKind
  timestamp: string
  detail: string
  toolName?: string | undefined
  count?: number
}

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface TokenSnapshot {
  timestamp: string
  cumulativeInput: number
  cumulativeOutput: number
}

export interface SessionAnalytics {
  sessionId: string
  projectDir: string
  gitBranch: string | null
  model: string | null
  claudeVersion: string | null
  startTime: string
  endTime: string
  durationMs: number
  userTurns: number
  assistantTurns: number
  isCompacted: boolean
  compactionCount: number
  sidechainEventCount: number
  toolCalls: ToolCall[]
  toolCallsByName: Record<string, number>
  uniqueToolsUsed: string[]
  errors: ErrorEvent[]
  errorCount: number
  errorRate: number
  tokens: TokenTotals
  frictionSignals: FrictionSignal[]
  hookEventCount: number
  hookPreventionCount: number
  capturedViaHooks: boolean
  capturedViaJsonl: boolean
  slug: string | null
  logicalParentUuid: string | null
  compactionTimestamps: string[]
  compactionSummaries: string[]
  compactionByteOffsets: number[]
  tokenSnapshots: TokenSnapshot[]
  assistantTexts: string[]
  userTexts: string[]
  filesTouched: Map<string, Set<string>>
  filesWritten: string[]
  taskRefs: string[]
  modelCounts: Map<string, number>
  thinkingBlockCount: number
  planPresent: boolean
  permissionMode: string | null
  serviceTier: string | null
  gitCommandCount: number
  commitCount: number
  subagentCount: number
  skillUsage: Map<string, number>
}
