/**
 * Dashboard Design Tokens — v3, resolved from titan-design
 *
 * Principle: every color on the page traces back to a titan-design semantic
 * token. Nothing below is a hand-picked hex; the only literals left are
 * opacities. Three layers: Palette (hue families), Semantic (meaning),
 * Component (usage).
 *
 * `T` is titan's resolved DARK token set. The dashboard is dark-only today, so
 * it resolves once at module load rather than through a theme context; adding
 * light mode means threading `getSemanticColors('light')` through a provider,
 * not editing values here.
 *
 * The backward-compat `colors` export preserves the exact shape of the v1 API.
 */

import {
  categoricalPalette,
  getSemanticColors,
  greyRamp,
  primitiveColors,
} from '@titan-design/react-ui/theme/tokens'
import { alpha, generateShades } from './utils/color-utils.js'

const T = getSemanticColors('dark')

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Primitive Palette
// ═══════════════════════════════════════════════════════════════════════════

// Hue families, each anchored on the titan token that carries its meaning.
// Pre-compute shade scales so the palette object can be `as const`.
const _brand = generateShades(T['brand-primary'])
const _teal = generateShades(T['status-success'])
const _red = generateShades(T['status-error'])
const _amber = generateShades(T['status-warning'])
const _gold = generateShades(T['status-warning-dark'])
const _userBlue = generateShades(T['status-info-light'])
const _accentBlue = generateShades(T['status-info-dark'])
const _steel = generateShades(T['brand-secondary'])
const _purple = generateShades(T['data-5'])
const _green = generateShades(T['status-live'])
const _gray = generateShades(greyRamp[600])

export const palette = {
  // -- Neutrals / Surfaces --
  black: primitiveColors.black,
  white: primitiveColors.white,
  bg: T['background-base'],
  surface1: T['surface-elevated'],
  surface2: T['surface-raised'],
  surface3: T['surface-overlay'],

  // -- Brand --
  brand: {
    ..._brand,
    // Extra shades beyond the standard scale
    dim06: alpha(T['brand-primary'], 0.06),
    dim20: alpha(T['brand-primary'], 0.2),
    dim30: alpha(T['brand-primary'], 0.3),
  },

  // -- Teal (success/done/write) --
  teal: {
    ..._teal,
    // Extra shades beyond the standard scale
    dim10: alpha(T['status-success'], 0.1),
    dim20: alpha(T['status-success'], 0.2),
  },

  // -- Red (error/blocked) --
  red: {
    ..._red,
    light: T['status-error-light'],
    // Extra shades beyond the standard scale
    dim10: alpha(T['status-error'], 0.1),
    dim20: alpha(T['status-error'], 0.2),
    dim30: alpha(T['status-error'], 0.3),
  },

  // -- Critical (priority only) --
  critical: {
    base: T['status-error-vivid'],
  },

  // -- Amber (edit/idle/warning) --
  amber: {
    ..._amber,
    // Extra shades beyond the standard scale
    dim20: alpha(T['status-warning'], 0.2),
    dim40: alpha(T['status-warning'], 0.4),
  },

  // -- Gold (ready/queued) --
  gold: {
    ..._gold,
  },

  // -- Blue (info/read) --
  blue: {
    base: T['status-info'],
    dark: T['status-info-dark'],
    light: T['status-info-light'],
  },

  // -- User blue (message cards) --
  userBlue: {
    ..._userBlue,
    // Special named aliases kept for semantic clarity
    bgDark: alpha(T['status-info-dark'], 0.35),
    border50: alpha(T['status-info-light'], 0.5),
    // Extra shades beyond the standard scale
    dim35: alpha(T['status-info-light'], 0.35),
  },

  // -- SubagentDrawer blue (deeper than info blue) --
  accentBlue: {
    ..._accentBlue,
    // Extra shades beyond the standard scale
    dim06: alpha(T['status-info-dark'], 0.06),
    dim20: alpha(T['status-info-dark'], 0.2),
    dim40: alpha(T['status-info-dark'], 0.4),
  },

  // -- Steel (secondary accent) --
  steel: {
    ..._steel,
    // Extra shades beyond the standard scale
    dim30: alpha(T['brand-secondary'], 0.3),
  },

  // -- Purple (review/grep/glob) --
  purple: {
    base: T['data-5'],
    light: T['data-9'],
    dim20: alpha(T['data-5'], 0.2),
  },

  // -- Green (live/active dot) --
  green: {
    ..._green,
  },

  // -- Gray (bash/inactive) --
  gray: {
    base: T['text-secondary'],
    dark: T['text-tertiary'],
    darker: greyRamp[700],
    // dim variants sit on the mid-grey step, for subtle backgrounds
    dim15: _gray.dim15,
    dim20: alpha(greyRamp[600], 0.2),
  },

  // -- Overlay --
  // The two steps titan names as interaction states use those tokens; the rest
  // are plain scrims with no semantic role, derived off titan's primitives.
  overlay: {
    white02: alpha(primitiveColors.white, 0.02),
    white03: alpha(primitiveColors.white, 0.03),
    white04: T['interactive-hover'],
    white06: alpha(primitiveColors.white, 0.06),
    white12: T['interactive-focus'],
    white25: alpha(primitiveColors.white, 0.25),
    black30: alpha(primitiveColors.black, 0.3),
    black40: alpha(primitiveColors.black, 0.4),
    black70: alpha(primitiveColors.black, 0.7),
  },

  // -- Chart series palette --
  series: [
    T['data-1'],
    T['data-2'],
    T['data-3'],
    T['data-4'],
    T['data-5'],
    T['data-6'],
    T['data-7'],
    T['data-8'],
    T['data-9'],
  ] as const,

  // -- Avatar palette --
  // titan's CVD-solved categorical set, so two agents adjacent on the roster
  // stay tellable apart.
  avatar: categoricalPalette.default,

  // -- Chart data colors (extended for NotesBreakdown) --
  dataColors: [
    T['data-1'],
    T['data-2'],
    T['data-3'],
    T['data-4'],
    T['data-5'],
    T['data-6'],
    T['data-7'],
    T['data-8'],
    T['data-9'],
    T['data-10'],
  ] as const,
} as const

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Semantic Aliases
// ═══════════════════════════════════════════════════════════════════════════

export const semantic = {
  // -- Typography --
  text: {
    primary: T['text-primary'],
    secondary: T['text-secondary'],
    tertiary: T['text-tertiary'],
    // `inverse` here means "text sitting ON a filled brand/accent fill", which
    // is titan's `on-brand-primary` (white). Titan's own `text-inverse` is the
    // opposite thing — near-black, for dark text on a light page — and using it
    // would put #1C1916 on the orange active-filter chip.
    inverse: T['on-brand-primary'],
  },

  // -- Surfaces --
  surface: {
    page: palette.bg,
    card: palette.surface1,
    nested: palette.surface2,
    elevated: palette.surface3,
  },

  // titan retired solid dark borders in favour of alpha hairlines.
  border: T['hairline-default'],

  // -- Status --
  status: {
    success: T['status-success'],
    error: T['status-error'],
    warning: T['status-warning'],
    info: T['status-info'],
    // A session that is working is live right now, which is what `status-live`
    // is for. `status-live` and `status-success` resolve to the same green
    // today, so anything meaning "idle but healthy" uses `liveMuted` to stay
    // distinguishable from it.
    active: T['status-live'],
    live: T['status-live'],
    liveMuted: T['status-live-muted'],
    idle: T['status-warning'],
    done: T['status-success'],
    blocked: T['status-error'],
    // `dnd` is a boolean flag, not a session status — it reads as a muted chip.
    dnd: T['text-tertiary'],
    pending: T['text-tertiary'],
    static: palette.gray.darker,
  },

  // -- Priority --
  priority: {
    critical: palette.critical.base,
    high: palette.red.base,
    medium: palette.amber.base,
    low: palette.blue.base,
    lowStripe: palette.blue.dark,
  },

  // -- Column / workflow stage --
  column: {
    blocked: palette.red.base,
    ready: palette.gold.base,
    inprogress: palette.blue.base,
    review: palette.purple.base,
    done: palette.teal.base,
  },

  // -- Tool types --
  tool: {
    read: { fg: palette.blue.light, bg: palette.accentBlue.dim20 },
    write: { fg: palette.teal.base, bg: palette.teal.dim20 },
    edit: { fg: palette.amber.base, bg: palette.amber.dim20 },
    bash: { fg: palette.gray.base, bg: palette.gray.dim20 },
    grep: { fg: palette.purple.light, bg: palette.purple.dim20 },
    glob: { fg: palette.purple.light, bg: palette.purple.dim20 },
    agent: { fg: palette.brand.base, bg: palette.brand.dim12 },
  },

  // -- Tool pill variants (slightly different bg) --
  toolPill: {
    read: { fg: palette.blue.light, bg: palette.accentBlue.dim20 },
    write: { fg: palette.teal.base, bg: palette.teal.dim20 },
    bash: { fg: palette.amber.base, bg: palette.amber.dim15 },
    agent: { fg: palette.brand.base, bg: palette.brand.dim12 },
  },

  // -- Roles --
  role: {
    user: {
      accent: palette.userBlue.base,
      text: palette.blue.light,
      bg: palette.userBlue.bgDark,
      border: palette.userBlue.border50,
    },
    claude: {
      accent: palette.brand.base,
      text: palette.brand.base,
      bg: palette.brand.dim08,
      border: palette.brand.dim25,
    },
  },

  // -- Agent activity (CC-66) --
  // The four categories the network graph glows by, kept in the same layer as
  // `tool` so the dashboard has ONE colour language for "what is this node
  // doing" rather than a second one invented for the graph. Each is picked to
  // stay distinguishable from every `tool` entry: `message` takes the LIGHT info
  // blue because `read` already holds the mid one, and `notice` stays tertiary
  // grey to agree with `eventKindColor`.
  activity: {
    message: palette.userBlue.base,
    question: palette.amber.base,
    notice: palette.gray.dark,
    thinking: palette.purple.light,
  },

  // -- Error text on dark --
  errorText: palette.red.light,

  // -- Brand accent --
  accent: palette.brand.base,
  accentDim: palette.brand.dim12,
} as const

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3: Component Tokens
// ═══════════════════════════════════════════════════════════════════════════

export const component = {
  // -- App shell / sidebar --
  sidebar: {
    bg: palette.surface1,
    border: semantic.border,
    navHoverBg: palette.overlay.white04,
    navActiveBg: palette.brand.dim08,
    navActiveBar: palette.brand.base,
  },

  // -- Card --
  card: {
    plainBg: palette.surface2,
    subtleBg: palette.overlay.white03,
    border: semantic.border,
  },

  // -- User message card --
  userCard: {
    bg: semantic.role.user.bg,
    border: semantic.role.user.border,
    accent: semantic.role.user.accent,
    labelColor: semantic.role.user.text,
    textColor: semantic.text.primary,
  },

  // -- Claude response card --
  claudeCard: {
    bg: semantic.role.claude.bg,
    border: semantic.role.claude.border,
    accent: semantic.role.claude.accent,
    labelColor: semantic.role.claude.text,
    errorAccent: semantic.status.error,
    toolSectionBorder: palette.brand.dim12,
    codeInlineBg: palette.overlay.white06,
  },

  // -- Tool call row --
  toolCallRow: {
    errorBorder: palette.red.dim25,
    errorBg: palette.red.dim05,
    agentBorder: palette.brand.dim20,
    agentBg: palette.brand.dim06,
  },

  // -- Summary card --
  summaryCard: {
    bg: palette.overlay.white03,
    border: palette.brand.dim15,
    errorBorder: palette.red.dim25,
  },

  // -- Error block --
  errorBlock: {
    bg: palette.red.dim08,
    border: palette.red.dim20,
    textColor: palette.red.light,
    toggleColor: palette.red.base,
  },

  // -- Badge (opacity-derived) --
  badge: {
    defaultBgOpacity: 0.12,
    defaultBorderOpacity: 0.25,
  },

  // -- Task / kanban pills --
  taskPill: {
    ready: { bg: palette.gold.dim15, fg: palette.gold.base, border: palette.gold.base },
    active: { bg: palette.brand.dim15, fg: palette.brand.base, border: palette.brand.base },
    done: { bg: palette.teal.dim12, fg: palette.teal.base, border: palette.teal.base },
  },

  // -- Task chip --
  taskChip: {
    color: palette.brand.base,
    bg: palette.brand.dim12,
    activeBg: palette.brand.dim25,
    borderColor: palette.brand.dim25,
  },

  // -- Kanban column header --
  kanbanHead: {
    ready: { bg: palette.gold.dim12, fg: palette.gold.base },
    active: { bg: palette.brand.dim12, fg: palette.brand.base },
    done: { bg: palette.teal.dim10, fg: palette.teal.base },
  },

  // -- Status badges --
  statusBadge: {
    complete: { bg: palette.teal.dim12, fg: palette.teal.base, border: palette.teal.dim25 },
    error: { bg: palette.red.dim12, fg: palette.red.base, border: palette.red.dim25 },
    active: { bg: palette.brand.dim12, fg: palette.brand.base, border: palette.brand.dim25 },
  },

  // -- Agent dot --
  agentDot: {
    live: { bg: palette.green.base, glow: palette.green.dim50 },
    idle: { bg: palette.amber.base, glow: palette.amber.dim40 },
    done: { bg: semantic.text.tertiary, glow: undefined as string | undefined },
  },

  // -- Timeline dots --
  timelineDot: {
    user: palette.userBlue.base,
    ok: palette.teal.base,
    err: palette.red.base,
    agent: palette.brand.base,
    info: semantic.text.tertiary,
  },

  // -- MiniStatus dots --
  miniStatus: {
    success: palette.teal.base,
    error: palette.red.base,
    pending: semantic.text.tertiary,
  },

  // -- Token gauge --
  tokenGauge: {
    inputBar: palette.blue.base,
    outputBar: palette.brand.base,
    track: palette.surface3,
    inputLabel: palette.blue.base,
    outputLabel: palette.brand.base,
  },

  // -- StatCard --
  statCard: {
    bg: palette.surface1,
    border: semantic.border,
    positiveDeltaBg: palette.teal.dim15,
    negativeDeltaBg: palette.red.dim15,
    positiveSpark: palette.brand.base,
    negativeSpark: palette.red.base,
  },

  // -- Context window chart --
  contextChart: {
    input: palette.blue.dark,
    output: palette.brand.base,
    compaction: palette.red.base,
    marker: palette.white,
  },

  // -- Files widget --
  filesWidget: {
    readLabel: palette.blue.light,
    readFill: palette.blue.dark,
    writeColor: palette.teal.base,
    trackBg: palette.surface3,
  },

  // -- Activity minimap --
  minimap: {
    blueTick: palette.userBlue.dim35,
    viewportBg: palette.overlay.white12,
    viewportBorder: palette.overlay.white25,
  },

  // -- Drawer / modal overlays --
  drawer: {
    backdrop: palette.overlay.black40,
    bg: palette.surface1,
    border: semantic.border,
  },

  // -- Command palette --
  commandPalette: {
    overlayBg: palette.overlay.black70,
    panelBg: palette.surface3,
    activeItemBg: palette.brand.dim08,
  },

  // -- Live indicator --
  liveIndicator: {
    active: palette.teal.base,
    static: palette.gray.darker,
  },

  // -- Workstream badge --
  workstreamBadge: {
    bg: palette.steel.dim15,
    border: palette.steel.dim30,
    text: palette.steel.base,
  },

  // -- SubagentDrawer tool row --
  subagentToolRow: {
    bg: palette.accentBlue.dim06,
    border: palette.accentBlue.dim15,
    leftAccent: palette.accentBlue.dim40,
  },

  // -- Swimlane header --
  swimlaneHeader: {
    bg: palette.overlay.white02,
  },
} as const

// ═══════════════════════════════════════════════════════════════════════════
// Backward-compat re-exports (existing shape preserved)
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated Use `palette.*` / `semantic.*` / `component.*` */
export const colors = {
  bg: palette.bg,
  surface1: palette.surface1,
  surface2: palette.surface2,
  surface3: palette.surface3,
  brand: palette.brand.base,
  steel: palette.steel.base,
  textPrimary: semantic.text.primary,
  textSecondary: semantic.text.secondary,
  textTertiary: semantic.text.tertiary,
  success: semantic.status.success,
  error: semantic.status.error,
  warning: semantic.status.warning,
  info: semantic.status.info,
  border: semantic.border,
} as const

/**
 * Activity type colors for sparklines, tool breakdowns and the agent network
 * graph. The first five are tool calls read out of a transcript; the last four
 * are agent-to-agent traffic read out of the event log (CC-66). One map, because
 * both answer the same question — what is this agent doing right now — and two
 * maps would drift into two colour languages on the same page.
 */
export const TOOL_COLORS: Record<string, string> = {
  read: semantic.status.info,
  write: palette.brand.base,
  bash: palette.teal.base,
  search: palette.steel.base,
  error: palette.red.base,
  message: semantic.activity.message,
  question: semantic.activity.question,
  notice: semantic.activity.notice,
  thinking: semantic.activity.thinking,
}

// ---------------------------------------------------------------------------
// Categorical color palettes — for avatar hashing, chart series, etc.
// ---------------------------------------------------------------------------

/** Stable palette for deterministic avatar / agent coloring. */
export const AVATAR_COLORS = palette.avatar

// ---------------------------------------------------------------------------
// Spacing scale (px values)
// ---------------------------------------------------------------------------

export const spacing = {
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 10,
  6: 12,
  7: 14,
  8: 16,
  10: 20,
  12: 24,
} as const

/** Short alias for spacing scale. sp[4] → 8, sp[8] → 16, sp[10] → 20 */
export const sp = spacing

// ---------------------------------------------------------------------------
// Border radius scale (px values)
// ---------------------------------------------------------------------------

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const typography = {
  fonts: {
    heading: "'Space Grotesk', sans-serif",
    body: "'Inter', sans-serif",
    mono: 'monospace',
  },
  sizes: {
    xs: '11px',
    sm: '12px',
    md: '14px',
    lg: '16px',
    xl: '20px',
    '2xl': '24px',
    '3xl': '32px',
  },
  weights: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
} as const

/**
 * Typography presets — compose font, size, weight, and lineHeight into
 * StyleSheet-compatible TextStyle objects. Use via `type.headingSm` etc.
 */
export const type = {
  // Headings (Space Grotesk)
  headingXs: {
    fontFamily: typography.fonts.heading,
    fontSize: 11,
    fontWeight: '600' as const,
    lineHeight: 11 * 1.2,
  },
  headingSm: {
    fontFamily: typography.fonts.heading,
    fontSize: 12,
    fontWeight: '600' as const,
    lineHeight: 12 * 1.2,
  },
  headingMd: {
    fontFamily: typography.fonts.heading,
    fontSize: 14,
    fontWeight: '600' as const,
    lineHeight: 14 * 1.2,
  },
  headingLg: {
    fontFamily: typography.fonts.heading,
    fontSize: 16,
    fontWeight: '600' as const,
    lineHeight: 16 * 1.2,
  },
  headingXl: {
    fontFamily: typography.fonts.heading,
    fontSize: 20,
    fontWeight: '700' as const,
    lineHeight: 20 * 1.2,
  },
  heading2xl: {
    fontFamily: typography.fonts.heading,
    fontSize: 24,
    fontWeight: '700' as const,
    lineHeight: 24 * 1.2,
  },
  heading3xl: {
    fontFamily: typography.fonts.heading,
    fontSize: 32,
    fontWeight: '700' as const,
    lineHeight: 32 * 1.2,
  },

  // Body (Inter)
  bodyXs: {
    fontFamily: typography.fonts.body,
    fontSize: 11,
    fontWeight: '400' as const,
    lineHeight: 11 * 1.5,
  },
  bodySm: {
    fontFamily: typography.fonts.body,
    fontSize: 12,
    fontWeight: '400' as const,
    lineHeight: 12 * 1.5,
  },
  bodyMd: {
    fontFamily: typography.fonts.body,
    fontSize: 14,
    fontWeight: '400' as const,
    lineHeight: 14 * 1.5,
  },
  bodyLg: {
    fontFamily: typography.fonts.body,
    fontSize: 16,
    fontWeight: '400' as const,
    lineHeight: 16 * 1.5,
  },

  // Labels (Space Grotesk, uppercase-ready)
  labelXs: {
    fontFamily: typography.fonts.heading,
    fontSize: 9,
    fontWeight: '600' as const,
    letterSpacing: 0.5,
  },
  labelSm: {
    fontFamily: typography.fonts.heading,
    fontSize: 10,
    fontWeight: '600' as const,
    letterSpacing: 0.5,
  },
  labelMd: {
    fontFamily: typography.fonts.heading,
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 0.5,
  },

  // Mono
  monoXs: { fontFamily: typography.fonts.mono, fontSize: 11, fontWeight: '400' as const },
  monoSm: { fontFamily: typography.fonts.mono, fontSize: 12, fontWeight: '400' as const },
  monoMd: { fontFamily: typography.fonts.mono, fontSize: 14, fontWeight: '400' as const },

  // Metric / stat values
  metricLg: {
    fontFamily: typography.fonts.heading,
    fontSize: 28,
    fontWeight: '700' as const,
    lineHeight: 28 * 1.2,
  },
  metricXl: {
    fontFamily: typography.fonts.heading,
    fontSize: 32,
    fontWeight: '700' as const,
    lineHeight: 32 * 1.2,
  },
} as const

// ---------------------------------------------------------------------------
// Elevation / surface colors
// Layers ordered from deepest (base) to highest (overlay)
// ---------------------------------------------------------------------------

export const elevation = {
  /** Page background */
  base: palette.bg,
  /** Cards and panels */
  raised: palette.surface1,
  /** Nested cards, sidebars */
  overlay: palette.surface2,
  /** Tooltips, dropdowns */
  floating: palette.surface3,
} as const
