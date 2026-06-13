// Per-user app settings, persisted via the SDK's localStorage (survives app
// restarts; stored per-user in the Even companion app). Each user supplies
// their OWN Soniox API key so they're billed for their own usage.

export interface AppSettings {
  /** User's Soniox API key. Empty until they set it in the phone UI. */
  apiKey: string
  /** Translation target language code ('' = transcript only). */
  targetLang: string
  /** Show the original-language transcript strip (off = translation full-screen). */
  showTranscript: boolean
  /** Language codes to keep as-is / NOT translate (the target is always kept). */
  noTranslateLangs: string[]
  /** Newline per sentence (at . ? ! + Soniox pauses). */
  splitSentences: boolean
  /** Speaker diarization with per-speaker icons. */
  speakerLabels: boolean
  /** Horizontal text alignment on the glasses ('center' is faked via space padding). */
  align: 'left' | 'center'
  /** Vertical anchor: 'bottom' pins the newest line to the pane bottom (grows up); 'top' fills from the top. */
  vAlign: 'top' | 'bottom'
  /** Blank lines inserted between content lines (0 = normal, 1 = relaxed, 2 = loose). */
  lineGap: number
  /** Text column width as a percent of the 576px display (100 = full, centered when narrower). */
  widthPct: number
  /** Max visible lines in the main pane (0 = auto / fill the pane). */
  maxLines: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  targetLang: 'en',
  showTranscript: true,
  noTranslateLangs: [],
  splitSentences: true,
  speakerLabels: false,
  align: 'left',
  vAlign: 'bottom',
  lineGap: 0,
  widthPct: 100,
  maxLines: 0,
}

// Single localStorage key holding the JSON-serialized settings.
export const SETTINGS_KEY = 'soniox.settings.v1'

export function mergeSettings(raw: string | null | undefined): AppSettings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
