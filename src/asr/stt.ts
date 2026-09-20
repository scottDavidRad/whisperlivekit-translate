// WhisperLiveKit 0.2.19 /asr client. Server must run with --pcm-input.
// Binary PCM s16le, 16 kHz mono; server responses replace cumulative snapshots.
import { validateServerUrl } from '../settings.ts'
import { isSourceLanguage } from '../languages.ts'

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
          if (!speakers.has(speaker)) speakers.set(speaker, nextSpeaker++)
          part = `Speaker ${speakers.get(speaker)}: ${part}`
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
        sessionFinal = formatLines(labeledLines)
        const extra = duplicated && !opts.speakerLabels ? '' : diarization
        interimText = joinText(extra, transcription)
        if (opts.speakerLabels && interimText.trim()) {
          interimText = `${history || sessionFinal ? '\n' : ''}Speaker pending: ${interimText.trim()}`
        } else if (interimText && (history || sessionFinal) && !/^\s/.test(interimText)) interimText = ' ' + interimText
        emit()
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
  }
}
