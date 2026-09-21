/** Display numbers are session-local; only the backend's voice profiles persist. */
export interface SpeakerView {
  speaker: number
  name?: string
  profileId?: string
  seconds: number
}

export interface SpeakerProfile { id: string; name: string }
export interface SpeakerState {
  status: 'loading' | 'ready' | 'disabled' | 'unavailable'
  message?: string
  speakers: SpeakerView[]
  profiles: SpeakerProfile[]
}
export interface SpeakerResult {
  action: 'enroll' | 'rename' | 'forget'
  ok: boolean
  message: string
}

/** Plain names only: prevent line breaks, caption delimiters and control text. */
export function normalizeSpeakerName(value: string): string {
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ')
  if (!name || [...name].length > 40 || !/^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u.test(name) ||
      /^(?:speaker|person|pending|unknown speaker)$/i.test(name)) return ''
  return name
}
