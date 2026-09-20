// Language tokens supported by multilingual Whisper small (99 languages).
// Source: faster-whisper 1.2.1 tokenizer; Cantonese is only in newer large models.
export interface Language { code: string; name: string }

const CODES = ["af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "zh"]
const names = new Intl.DisplayNames(['en'], { type: 'language' })
const explicitNames: Record<string, string> = { ba: 'Bashkir', bo: 'Tibetan', jw: 'Javanese' }
export const LANGUAGES: Language[] = [
  { code: 'auto', name: 'Auto — detect automatically' },
  ...CODES.map(code => ({ code, name: explicitNames[code] || names.of(code) || code.toUpperCase() }))
    .sort((a, b) => a.name.localeCompare(b.name)),
]
export const isSourceLanguage = (value: unknown): value is string =>
  typeof value === 'string' && (value === 'auto' || CODES.includes(value))
export const langName = (code: string) => code === 'auto' ? 'Auto' : LANGUAGES.find(language => language.code === code)?.name || code.toUpperCase()
