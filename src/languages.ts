// Curated subset of Soniox's 60+ supported translation targets (any supported
// language can be a target). Extend freely — every code below is valid.
// Full list: https://soniox.com/docs/stt/concepts/supported-languages
export interface Language {
  code: string
  name: string
}

export const LANGUAGES: Language[] = [
  { code: '', name: 'None — transcript only' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'zh', name: 'Chinese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'ko', name: 'Korean' },
  { code: 'it', name: 'Italian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'id', name: 'Indonesian' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
]

export function langName(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.name ?? code.toUpperCase()
}
