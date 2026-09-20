export interface ConversationCue { kind: 'concept' | 'answer' | 'suggestion' | 'bio' | 'none'; text: string }
export interface ConversationConfig { configured: boolean; provider: string; model: string; reason?: string }
export interface ConversationSummary { summary: string; action_items: string[] }

export function conversationUrl(serverUrl: string, action: 'config' | 'cue' | 'summary'): string {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = url.pathname.replace(/\/asr\/?$/, '') + `/conversation/${action}`
  url.search = ''
  url.hash = ''
  return url.href
}

export async function conversationRequest<T>(
  serverUrl: string, action: 'config' | 'cue' | 'summary', body?: unknown, signal?: AbortSignal, provider?: string,
): Promise<T> {
  const url = new URL(conversationUrl(serverUrl, action))
  if (provider) url.searchParams.set('provider', provider)
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? data.detail : ''
    throw new Error(typeof detail === 'string' ? detail : `AI service returned ${response.status}.`)
  }
  if (!data || typeof data !== 'object') throw new Error('AI service returned an invalid response.')
  return data as T
}

/** One request at a time, only after new committed speech. Cancelling also
 * invalidates responses from a provider which ignores the abort signal. */
export class ConversationSession {
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private generation = 0
  private text = ''
  private lastRequested = ''
  private lastRequestAt = 0
  private previousCues: string[] = []
  private paused = false
  constructor(private options: {
    serverUrl: string
    prepNotes: string
    provider: string
    onCue: (cue: ConversationCue) => void
    onStatus: (message: string) => void
  }) {}
  update(text: string) {
    this.text = text
    if (this.paused || this.controller || this.timer || text.length < 20 || text === this.lastRequested) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.request() },
      Math.max(1500, 12_000 - (Date.now() - this.lastRequestAt)))
  }
  async request() {
    if (this.paused || this.controller || this.text.length < 20 || this.text === this.lastRequested) return
    clearTimeout(this.timer)
    this.timer = undefined
    const generation = this.generation
    const controller = this.controller = new AbortController()
    this.lastRequestAt = Date.now()
    const requestedText = this.text
    this.options.onStatus('Following the conversation…')
    try {
      const cue = await conversationRequest<ConversationCue>(this.options.serverUrl, 'cue', {
        transcript: this.text.slice(-16_000), prep_notes: this.options.prepNotes,
        previous_cues: this.previousCues.slice(-5),
        provider: this.options.provider,
      }, controller.signal)
      if (generation !== this.generation) return
      if (!['concept', 'answer', 'suggestion', 'bio', 'none'].includes(cue.kind) || typeof cue.text !== 'string') {
        throw new Error('AI service returned an invalid cue.')
      }
      this.lastRequested = requestedText
      if (cue.kind !== 'none' && cue.text.trim()) {
        cue.text = cue.text.slice(0, 200)
        this.previousCues.push(cue.text)
        this.options.onCue(cue)
      }
      this.options.onStatus('AI assistance is ready')
    } catch (error) {
      if (generation === this.generation) this.options.onStatus(error instanceof Error ? error.message : 'AI assistance is unavailable.')
    } finally {
      if (generation === this.generation) {
        this.controller = undefined
        this.update(this.text)
      }
    }
  }
  pause() {
    this.paused = true
    this.generation++
    clearTimeout(this.timer); this.timer = undefined
    this.controller?.abort(); this.controller = undefined
  }
  resume() { this.paused = false; this.update(this.text) }
  dispose() { this.pause() }
}
