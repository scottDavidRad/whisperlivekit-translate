// WhisperLiveKit 0.2.19 /asr client. Server must run with --pcm-input.
// Binary PCM s16le, 16 kHz mono; server responses replace cumulative snapshots.
import { validateServerUrl } from '../settings.ts'
import { isSourceLanguage } from '../languages.ts'
import { normalizeSpeakerName, type SpeakerState, type SpeakerResult } from '../speakers.ts'

const MAX_PENDING_BYTES = 160_000
const BACKPRESSURE_BYTES = 256_000
const MAX_TEXT = 100_000

export type SttStatus = 'connecting' | 'live' | 'reconnecting' | 'closed'
export interface SttOptions {
  serverUrl: string
  /** Auto is the default app mode; a code selects manual input recognition. */
  sourceLanguage?: string
  task?: 'translate' | 'transcribe'
  /** Continue anonymous numbering when the app starts a fresh backend session. */
  firstSpeaker?: number
  splitSentences?: boolean
  /** Display speaker IDs supplied by a server running with --diarization. */
  speakerLabels?: boolean
  /** Save and match named voices on the configured backend, independently of ASR. */
  rememberSpeakers?: boolean
  onSpeakers?: (state: SpeakerState) => void
  onSpeakerResult?: (result: SpeakerResult) => void
}
export interface SttSnapshot {
  finalText: string
  interimText: string
  finished: boolean
}
export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  /** Flush audio and receive final results. */
  finish(): void
  /** Immediately release a superseded or abandoned session. */
  close(): void
  /** The speaker argument is the displayed number, never a reused backend slot. */
  enrollSpeaker(speaker: number, name: string): boolean
  renameSpeaker(profileId: string, name: string): boolean
  forgetSpeaker(profileId: string): boolean
}
interface WhisperLine { text?: string; speaker?: number }
interface WhisperResponse {
  type?: string
  useAudioWorklet?: boolean
  source_language?: string
  translation_mode?: 'english' | 'transcript'
  status?: string
  error?: string
  lines?: WhisperLine[]
  buffer_transcription?: string
  buffer_diarization?: string
  speaker_recognition?: boolean
  speakers?: Array<{ speaker: number; name?: string; profile_id?: string; seconds?: number }>
  profiles?: Array<{ id: string; name: string }>
  message?: string
  action?: string
  request_id?: string
  ok?: boolean
}

function joinText(a: string, b: string, separator = ' '): string {
  if (!a) return b
  if (!b) return a
  return a + (/\s$/.test(a) || /^\s/.test(b) ? '' : separator) + b
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Remove a duplicated pending suffix without assigning it a speaker yet. */
function withoutPendingSuffix(lines: WhisperLine[], keepCharacters: number): WhisperLine[] {
  let offset = 0
  return lines.flatMap((line, index) => {
    const text = normalizeText(line.text || '')
    const start = offset + (index ? 1 : 0)
    offset = start + text.length
    const retained = text.slice(0, Math.max(0, keepCharacters - start)).trimEnd()
    return retained ? [{ ...line, text: retained }] : []
  })
}

export function startSttStream(
  opts: SttOptions,
  onSnapshot: (snapshot: SttSnapshot) => void,
  onError?: (error: unknown) => void,
  onStatus?: (status: SttStatus) => void,
): SttClient {
  const configuredUrl = validateServerUrl(opts.serverUrl)
  if (!configuredUrl) throw new Error('Set your WhisperLiveKit server URL in Settings.')
  const connectionUrl = new URL(configuredUrl)
  if (opts.sourceLanguage !== undefined) {
    if (!isSourceLanguage(opts.sourceLanguage)) throw new Error('Unsupported input language.')
    connectionUrl.searchParams.set('language', opts.sourceLanguage)
  }
  if (opts.task) connectionUrl.searchParams.set('task', opts.task)
  if (opts.rememberSpeakers) connectionUrl.searchParams.set('remember_speakers', '1')
  else connectionUrl.searchParams.delete('remember_speakers')
  const url = connectionUrl.href
  if (globalThis.location?.protocol === 'https:' && url.startsWith('ws:')) {
    throw new Error('An HTTPS app requires a secure wss:// WhisperLiveKit server.')
  }
  let socket: WebSocket | null = null
  let ready = false
  let stopped = false
  let finishing = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let connectionTimer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  let history = ''
  let sessionFinal = ''
  let interimText = ''
  let pendingBytes = 0
  const pending: Uint8Array[] = []
  const speakers = new Map<number, number>()
  let identityState: SpeakerState = { status: 'loading', speakers: [], profiles: [] }
  const identities = new Map<number, { name?: string; profileId?: string; seconds: number }>()
  let latestLines: WhisperLine[] = []
  let recognitionAvailable = false
  let requestNumber = 0
  const pendingRequests = new Set<string>()
  let nextSpeaker = Number.isSafeInteger(opts.firstSpeaker) && opts.firstSpeaker! > 0 ? opts.firstSpeaker! : 1

  function emit(finished = false) {
    onSnapshot({ finalText: joinText(history, sessionFinal, '\n').slice(-MAX_TEXT), interimText, finished })
  }
  function dispose() {
    stopped = true
    ready = false
    clearTimeout(reconnectTimer)
    clearTimeout(connectionTimer)
    clearTimeout(finishTimer)
    pending.length = 0
    pendingBytes = 0
    socket?.close()
    publishSpeakerState('unavailable', 'Start a session to manage saved voices.')
    onStatus?.('closed')
  }
  function fail(message: string) {
    if (stopped) return
    onError?.(new Error(message))
    dispose()
  }
  function endAudio() {
    // WLK receive_bytes() requires an empty BINARY frame, not an empty string.
    socket?.send(new Uint8Array(0))
  }
  function displaySpeaker(speaker: number): number {
    if (!speakers.has(speaker)) speakers.set(speaker, nextSpeaker++)
    return speakers.get(speaker)!
  }
  function publishSpeakerState(status = identityState.status, message = identityState.message) {
    if (!opts.rememberSpeakers) return
    identityState = { ...identityState, status, message, speakers: [...speakers].map(([raw, speaker]) => ({
      speaker, seconds: identities.get(raw)?.seconds ?? 0,
      name: identities.get(raw)?.name, profileId: identities.get(raw)?.profileId,
    })) }
    opts.onSpeakers?.(identityState)
  }
  function speakerProblem(action: SpeakerResult['action'], message: string): false {
    opts.onSpeakerResult?.({ action, ok: false, message })
    return false
  }
  function control(action: SpeakerResult['action'], data: Record<string, unknown>): boolean {
    if (!opts.rememberSpeakers || !recognitionAvailable || stopped || finishing || !ready ||
        socket?.readyState !== WebSocket.OPEN) return speakerProblem(action, 'Start a session with saved voice recognition enabled.')
    const request_id = `speaker-${++requestNumber}`
    try {
      socket.send(JSON.stringify({ type: `speaker_${action}`, request_id, ...data }))
      pendingRequests.add(request_id)
      return true
    } catch { return speakerProblem(action, 'Voice request could not be sent. Reconnect and try again.') }
  }
  function enrollSpeaker(speaker: number, value: string): boolean {
    const name = normalizeSpeakerName(value)
    if (!name) return speakerProblem('enroll', 'Enter a name using up to 40 letters, spaces, apostrophes or hyphens.')
    const raw = [...speakers].find(([, display]) => display === speaker)?.[0]
    if (raw === undefined) return speakerProblem('enroll', 'That speaker is not part of this audio session.')
    return control('enroll', { speaker: raw, name })
  }
  function formatLines(lines: WhisperLine[]) {
    let text = ''
    let lastSpeaker: number | null | undefined
    for (const line of lines) {
      let part = line.text!.trim()
      const speaker = typeof line.speaker === 'number' && Number.isInteger(line.speaker) && line.speaker > 0
        ? line.speaker : null
      const speakerChanged = opts.speakerLabels && speaker !== lastSpeaker
      if (speakerChanged) {
        if (speaker === null) part = `Speaker pending: ${part}`
        else {
          const display = displaySpeaker(speaker)
          const name = opts.rememberSpeakers ? identities.get(speaker)?.name : undefined
          part = `${name || `Speaker ${display}`}: ${part}`
        }
        lastSpeaker = speaker
      }
      text = joinText(text, part, opts.splitSentences || speakerChanged ? '\n' : ' ')
    }
    return text.slice(-MAX_TEXT)
  }
  function connect() {
    if (stopped || finishing) return
    onStatus?.(attempts ? 'reconnecting' : 'connecting')
    ready = false
    const current = new WebSocket(url)
    socket = current
    current.binaryType = 'arraybuffer'
    connectionTimer = setTimeout(() => {
      fail('WhisperLiveKit did not send its PCM configuration. Check the URL, network, and --pcm-input flag.')
    }, 15_000)
    current.addEventListener('message', event => {
      if (stopped || socket !== current) return
      let response: WhisperResponse
      try {
        response = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
        if (!response || typeof response !== 'object') return
      } catch { return }
      // Voice recognition is optional: its errors must never stop captions.
      if (response.type === 'speaker_state') {
        if (!opts.rememberSpeakers || !recognitionAvailable) return
        if (!['loading', 'ready', 'disabled', 'unavailable'].includes(response.status || '')) return
        identities.clear()
        for (const item of (Array.isArray(response.speakers) ? response.speakers : []).slice(0, 100)) {
          if (!item || !Number.isSafeInteger(item.speaker) || item.speaker <= 0) continue
          displaySpeaker(item.speaker)
          identities.set(item.speaker, {
            name: typeof item.name === 'string' ? normalizeSpeakerName(item.name) || undefined : undefined,
            profileId: typeof item.profile_id === 'string' ? item.profile_id.slice(0, 128) : undefined,
            seconds: typeof item.seconds === 'number' && Number.isFinite(item.seconds) ? Math.max(0, item.seconds) : 0,
          })
        }
        identityState.profiles = (Array.isArray(response.profiles) ? response.profiles : []).slice(0, 1000).flatMap(item => {
          if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || typeof item.name !== 'string') return []
          const name = normalizeSpeakerName(item.name)
          return name ? [{ id: item.id, name }] : []
        })
        publishSpeakerState(response.status as SpeakerState['status'], typeof response.message === 'string' ? response.message.slice(0, 500) : undefined)
        if (latestLines.length) { sessionFinal = formatLines(latestLines); emit() }
        return
      }
      if (response.type === 'speaker_result') {
        if (!response.request_id || !pendingRequests.delete(response.request_id)) return
        if (!['enroll', 'rename', 'forget'].includes(response.action || '')) return
        opts.onSpeakerResult?.({ action: response.action as SpeakerResult['action'], ok: response.ok === true,
          message: typeof response.message === 'string' ? response.message.slice(0, 500) : 'Voice request completed.' })
        return
      }
      if (response.error || response.status === 'error') {
        fail(`WhisperLiveKit: ${response.error || 'audio processing failed'}`)
        return
      }
      if (response.type === 'config') {
        if (ready) return
        if (response.useAudioWorklet !== true) {
          fail('Restart WhisperLiveKit with --pcm-input (16 kHz mono PCM is required).')
          return
        }
        if (opts.sourceLanguage !== undefined && response.source_language !== opts.sourceLanguage) {
          fail('The server did not confirm the selected input mode. Use this fork’s WhisperLiveKit server and reconnect.')
          return
        }
        if (opts.task && response.translation_mode !== (opts.task === 'translate' ? 'english' : 'transcript')) {
          fail('The server did not confirm the requested speech task. Update the included backend.')
          return
        }
        clearTimeout(connectionTimer)
        ready = true
        recognitionAvailable = response.speaker_recognition === true
        publishSpeakerState(recognitionAvailable ? 'loading' : 'unavailable', recognitionAvailable
          ? 'Preparing saved voice recognition…' : 'Saved voice recognition is unavailable on this backend. Captions still work.')
        attempts = 0
        onStatus?.('live')
        for (const chunk of pending) current.send(chunk)
        pending.length = 0
        pendingBytes = 0
        if (finishing) endAudio()
        return
      }
      if (response.type === 'ready_to_stop') {
        emit(true)
        dispose()
        return
      }
      if (Array.isArray(response.lines)) {
        const lines = response.lines.filter(line => line && line.speaker !== -2 && typeof line.text === 'string' && line.text.trim())
        // WLK 0.2.19 can include pending diarization in both lines and buffer.
        // Its fallback speaker 1 on that suffix is not a confirmed attribution.
        const diarization = typeof response.buffer_diarization === 'string' ? response.buffer_diarization : ''
        const transcription = typeof response.buffer_transcription === 'string' ? response.buffer_transcription : ''
        const pendingText = normalizeText(diarization)
        const lineText = normalizeText(lines.map(line => line.text).join(' '))
        const duplicated = !!pendingText && lineText.endsWith(pendingText)
        const labeledLines = opts.speakerLabels && duplicated
          ? withoutPendingSuffix(lines, lineText.length - pendingText.length)
          : lines
        latestLines = labeledLines
        sessionFinal = formatLines(labeledLines)
        const extra = duplicated && !opts.speakerLabels ? '' : diarization
        interimText = joinText(extra, transcription)
        if (opts.speakerLabels && interimText.trim()) {
          interimText = `${history || sessionFinal ? '\n' : ''}Speaker pending: ${interimText.trim()}`
        } else if (interimText && (history || sessionFinal) && !/^\s/.test(interimText)) interimText = ' ' + interimText
        emit()
        publishSpeakerState()

      }
    })
    current.addEventListener('error', () => {
      // Browsers provide no useful error body. The close event drives retry.
    })
    current.addEventListener('close', () => {
      if (stopped || socket !== current) return
      clearTimeout(connectionTimer)
      ready = false
      if (finishing) {
        fail('WhisperLiveKit disconnected before confirming the final transcript.')
        return
      }
      history = joinText(history, sessionFinal, '\n').slice(-MAX_TEXT)
      sessionFinal = ''
      interimText = ''
      // A fresh backend session cannot recognize identities from the old one.
      // Preserve distinct display labels instead of reusing Speaker 1.
      speakers.clear()
      identities.clear()
      latestLines = []
      pendingRequests.clear()
      recognitionAvailable = false
      publishSpeakerState('loading', 'Reconnecting. Voice identities will be checked again.')
      emit()
      onStatus?.('reconnecting')
      const delay = Math.min(8000, 500 * 2 ** attempts++)
      reconnectTimer = setTimeout(connect, delay)
    })
  }
  connect()
  return {
    sendPcm(chunk) {
      if (stopped || finishing || !chunk.byteLength) return
      if (socket?.readyState === WebSocket.OPEN && ready) {
        if (socket.bufferedAmount <= BACKPRESSURE_BYTES) socket.send(chunk)
      } else {
        // Keep at most five seconds of the newest audio while connecting.
        const copy = chunk.slice(-MAX_PENDING_BYTES)
        while (pending.length && pendingBytes + copy.byteLength > MAX_PENDING_BYTES) pendingBytes -= pending.shift()!.byteLength
        pending.push(copy)
        pendingBytes += copy.byteLength
      }
    },
    finish() {
      if (stopped || finishing) return
      if (!socket || socket.readyState > WebSocket.OPEN) {
        fail('Cannot finish while disconnected from WhisperLiveKit.')
        return
      }
      finishing = true
      clearTimeout(reconnectTimer)
      finishTimer = setTimeout(() => fail('Timed out waiting for WhisperLiveKit to finish processing audio.'), 60_000)
      if (ready) endAudio()
    },
    close: dispose,
    enrollSpeaker,
    renameSpeaker(profileId, value) {
      const name = normalizeSpeakerName(value)
      if (!name) return speakerProblem('rename', 'Enter a name using up to 40 letters, spaces, apostrophes or hyphens.')
      if (!identityState.profiles.some(profile => profile.id === profileId)) return speakerProblem('rename', 'Choose a saved voice first.')
      return control('rename', { profile_id: profileId, name })
    },
    forgetSpeaker(profileId) {
      if (!identityState.profiles.some(profile => profile.id === profileId)) return speakerProblem('forget', 'Choose a saved voice first.')
      return control('forget', { profile_id: profileId })
    },
  }
}
