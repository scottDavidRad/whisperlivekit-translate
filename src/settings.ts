import { isSourceLanguage } from './languages'

// Per-user display and self-hosted WhisperLiveKit connection settings.
// Stored through the SDK's localStorage in the Even companion app.

export type OutputMode = 'transcript' | 'translation'
export type AppMode = 'translate' | 'conversate'

export interface AppSettings {
  appMode: AppMode
  aiProvider: 'codex' | 'grok' | 'openai-compatible' | 'qwen'
  prepNotes: string
  cueAutoShow: boolean
  cueDurationSeconds: number
  /** Zero keeps captions until they are replaced. */
  captionHoldSeconds: number
  /** WebSocket URL of the user's WhisperLiveKit /asr endpoint. */
  serverUrl: string
  /** Auto detects speech; a language code opts into manual recognition. */
  sourceLanguage: string
  /** Selects which server output to show in the main pane. */
  outputMode: OutputMode
  /** Put each completed sentence on its own line. */
  splitSentences: boolean
  /** Show speaker labels when the server provides diarization. */
  speakerLabels: boolean
  /** Horizontal text alignment on the glasses. */
  align: 'left' | 'center'
  /** Vertical anchor within the glasses display. */
  vAlign: 'top' | 'bottom'
  /** Blank lines inserted between content lines. */
  lineGap: number
  /** Text column width as a percentage of the 576px display. */
  widthPct: number
  /** Max visible lines in the main pane (0 = automatic). */
  maxLines: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  appMode: 'translate',
  aiProvider: 'codex',
  prepNotes: '',
  cueAutoShow: true,
  cueDurationSeconds: 10,
  captionHoldSeconds: 5,
  serverUrl: '',
  sourceLanguage: 'auto',
  outputMode: 'translation',
  splitSentences: true,
  speakerLabels: true,
  align: 'left',
  vAlign: 'bottom',
  lineGap: 0,
  widthPct: 100,
  maxLines: 0,
}

export const SETTINGS_KEY = 'whisperlivekit.settings.v1'

/** Validate a connection URL. Empty is allowed so settings can remain in setup. */
export function validateServerUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Enter a full WebSocket URL, such as ws://192.168.1.20:8000/asr.')
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname) {
    throw new Error('The server URL must start with ws:// or wss://.')
  }
  if (url.username || url.password || url.hash) {
    throw new Error('The server URL cannot include credentials or a #fragment.')
  }
  return url.href
}

/** Restore only supported settings; malformed or obsolete fields use defaults. */
export function mergeSettings(raw: string | null | undefined): AppSettings {
  const settings = { ...DEFAULT_SETTINGS }
  if (!raw) return settings
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return settings
    parsed = value as Record<string, unknown>
  } catch {
    return settings
  }

  if (typeof parsed.serverUrl === 'string') {
    try {
      settings.serverUrl = validateServerUrl(parsed.serverUrl)
    } catch {
      // An invalid saved endpoint returns the app to setup.
    }
  }
  if (isSourceLanguage(parsed.sourceLanguage)) settings.sourceLanguage = parsed.sourceLanguage
  if (parsed.appMode === 'translate' || parsed.appMode === 'conversate') settings.appMode = parsed.appMode
  if (parsed.aiProvider === 'codex' || parsed.aiProvider === 'grok' || parsed.aiProvider === 'openai-compatible' || parsed.aiProvider === 'qwen') settings.aiProvider = parsed.aiProvider
  if (typeof parsed.prepNotes === 'string') settings.prepNotes = parsed.prepNotes.slice(0, 5000)
  if (typeof parsed.cueAutoShow === 'boolean') settings.cueAutoShow = parsed.cueAutoShow
  if (typeof parsed.cueDurationSeconds === 'number' && [5, 10, 15, 30].includes(parsed.cueDurationSeconds)) settings.cueDurationSeconds = parsed.cueDurationSeconds
  if (typeof parsed.captionHoldSeconds === 'number' && [0, 3, 5, 10, 15].includes(parsed.captionHoldSeconds)) settings.captionHoldSeconds = parsed.captionHoldSeconds
  if (parsed.outputMode === 'transcript' || parsed.outputMode === 'translation') {
    settings.outputMode = parsed.outputMode
  }
  for (const key of ['splitSentences', 'speakerLabels'] as const) {
    if (typeof parsed[key] === 'boolean') settings[key] = parsed[key]
  }
  if (parsed.align === 'left' || parsed.align === 'center') settings.align = parsed.align
  if (parsed.vAlign === 'top' || parsed.vAlign === 'bottom') settings.vAlign = parsed.vAlign
  if (typeof parsed.lineGap === 'number' && [0, 1, 2].includes(parsed.lineGap)) {
    settings.lineGap = parsed.lineGap
  }
  if (typeof parsed.widthPct === 'number' && [55, 70, 85, 100].includes(parsed.widthPct)) {
    settings.widthPct = parsed.widthPct
  }
  if (typeof parsed.maxLines === 'number' && [0, 1, 2, 3, 4, 5, 6, 8].includes(parsed.maxLines)) {
    settings.maxLines = parsed.maxLines
  }
  return settings
}
